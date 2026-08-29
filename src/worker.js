const SITE_URL = "https://www.aquafankw.com";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/create-payment") {
        if (request.method !== "POST") return json({ ok: false, error: "Method Not Allowed" }, 405);
        return createPayment(request, env);
      }
      if ((request.method === "GET" || request.method === "POST") && url.pathname === "/api/verify-payment") return verifyPayment(request, env);
      if (request.method === "POST" && url.pathname === "/api/myfatoorah/webhook") return handleWebhook(request, env);
      if (url.pathname === "/payment-success") return env.ASSETS.fetch(new URL("/payment-success.html", url));
      if (url.pathname === "/payment-failed") return env.ASSETS.fetch(new URL("/payment-failed.html", url));
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({ ok: false, error: error instanceof HttpError ? error.message : "حدث خطأ غير متوقع. حاولي مرة أخرى." }, error instanceof HttpError ? error.status : 500);
    }
  }
};

async function createPayment(request, env) {
  requireConfig(env, ["MYFATOORAH_API_KEY", "MYFATOORAH_BASE_URL", "DB"]);
  const body = await readJson(request);
  const customer = validateCustomer(body.customer);
  const requestedItems = validateRequestedItems(body.items);
  const products = await loadProducts(env, request.url);
  const productMap = new Map(products.map(product => [Number(product.id), product]));
  const items = requestedItems.map(item => {
    const product = productMap.get(item.id);
    if (!product || Number(product.stock) <= 0) throw new HttpError("أحد المنتجات غير متوفر.", 400);
    if (item.quantity > Number(product.stock)) throw new HttpError("الكمية المطلوبة غير متوفرة.", 400);
    const unitPrice = roundKwd(product.price);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new HttpError("سعر منتج غير صالح.", 500);
    return { id: item.id, quantity: item.quantity, unitPrice, name: String(product.nameAr || product.nameEn || `Product ${item.id}`).slice(0, 100) };
  });
  const subtotal = roundKwd(items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0));
  const deliveryFee = 0;
  const total = roundKwd(subtotal + deliveryFee);
  if (total <= 0) throw new HttpError("قيمة الطلب غير صالحة.", 400);

  const orderId = `AQ-${Date.now()}-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
  await env.DB.prepare(`INSERT INTO orders (id,status,customer_name,customer_phone,customer_email,customer_address,items_json,subtotal,delivery_fee,total) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(orderId, "PENDING", customer.name, customer.phone, customer.email, customer.address, JSON.stringify(items), subtotal, deliveryFee, total).run();

  const paymentPayload = {
    InvoiceValue: total,
    CustomerName: customer.name,
    NotificationOption: "LNK",
    DisplayCurrencyIso: "KWD",
    Language: "AR",
    CallBackUrl: `${SITE_URL}/payment-success`,
    ErrorUrl: `${SITE_URL}/payment-failed`,
    CustomerReference: orderId,
    MobileCountryCode: "965",
    CustomerMobile: normalizeKuwaitMobile(customer.phone),
    CustomerEmail: customer.email || undefined,
    CustomerAddress: { AddressInstructions: customer.address },
    InvoiceItems: items.map(item => ({ ItemName: item.name, Quantity: item.quantity, UnitPrice: item.unitPrice }))
  };

  const response = await myFatoorah(env, "/v2/SendPayment", paymentPayload);
  const invoiceURL = response?.Data?.InvoiceURL;
  const invoiceId = response?.Data?.InvoiceId;
  if (!invoiceURL) throw new HttpError("لم يتم إنشاء رابط الدفع.", 502);
  await env.DB.prepare("UPDATE orders SET invoice_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(String(invoiceId || ""), orderId).run();
  return json({ ok: true, orderId, invoiceURL });
}

async function verifyPayment(request, env) {
  requireConfig(env, ["MYFATOORAH_API_KEY", "MYFATOORAH_BASE_URL", "DB"]);
  const url = new URL(request.url);
  const body = request.method === "POST" ? await readJson(request) : {};
  const paymentId = String(url.searchParams.get("paymentId") || body.paymentId || "").trim();
  if (!paymentId || paymentId.length > 150) throw new HttpError("رقم الدفع غير صالح.", 400);
  const response = await myFatoorah(env, "/v2/GetPaymentStatus", { Key: paymentId, KeyType: "PaymentId" });
  const data = response?.Data || {};
  const paid = String(data.InvoiceStatus || "").toUpperCase() === "PAID";
  const orderId = String(data.CustomerReference || "");
  if (orderId) {
    await env.DB.prepare("UPDATE orders SET status=?, payment_id=?, invoice_id=COALESCE(NULLIF(?,''),invoice_id), updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(paid ? "PAID" : "FAILED", paymentId, String(data.InvoiceId || ""), orderId).run();
  }
  return json({ ok: true, paid, orderId, status: data.InvoiceStatus || "UNKNOWN" });
}

async function handleWebhook(request, env) {
  requireConfig(env, ["MYFATOORAH_WEBHOOK_SECRET", "DB"]);
  const rawBody = await request.text();
  const signature = request.headers.get("myfatoorah-signature") || request.headers.get("MyFatoorah-Signature") || "";
  if (!signature || !(await verifyHmac(rawBody, signature, env.MYFATOORAH_WEBHOOK_SECRET))) return new Response("Invalid signature", { status: 401 });
  const event = JSON.parse(rawBody);
  const data = event.Data || event.data || {};
  const orderId = String(data.CustomerReference || data.customerReference || "");
  const paymentId = String(data.PaymentId || data.paymentId || "");
  const invoiceId = String(data.InvoiceId || data.invoiceId || "");
  const statusText = String(data.InvoiceStatus || data.TransactionStatus || data.status || "").toUpperCase();
  const status = statusText === "PAID" || statusText === "SUCCESS" ? "PAID" : "FAILED";
  if (orderId) await env.DB.prepare("UPDATE orders SET status=?,payment_id=COALESCE(NULLIF(?,''),payment_id),invoice_id=COALESCE(NULLIF(?,''),invoice_id),updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(status, paymentId, invoiceId, orderId).run();
  return new Response("OK", { status: 200 });
}

async function loadProducts(env, requestUrl) {
  const response = await env.ASSETS.fetch(new URL("/products.json", requestUrl));
  if (!response.ok) throw new HttpError("تعذّر تحميل قائمة المنتجات.", 500);
  return response.json();
}

async function myFatoorah(env, path, payload) {
  const base = String(env.MYFATOORAH_BASE_URL).replace(/\/$/, "");
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { Authorization: `Bearer ${env.MYFATOORAH_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(payload) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.IsSuccess === false) {
    console.error("MyFatoorah error", response.status, result);
    throw new HttpError(result.Message || "تعذّر الاتصال بخدمة الدفع.", 502);
  }
  return result;
}

function validateCustomer(value = {}) {
  const customer = { name: clean(value.name, 100), phone: clean(value.phone, 20), email: clean(value.email, 150), address: clean(value.address, 300) };
  if (customer.name.length < 2) throw new HttpError("اكتبي اسم العميل.", 400);
  if (!/^\+?\d[\d\s-]{6,18}$/.test(customer.phone)) throw new HttpError("رقم الهاتف غير صالح.", 400);
  if (customer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) throw new HttpError("البريد الإلكتروني غير صالح.", 400);
  if (customer.address.length < 5) throw new HttpError("اكتبي عنوان التوصيل.", 400);
  return customer;
}
function validateRequestedItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 100) throw new HttpError("السلة فارغة أو غير صالحة.", 400);
  return items.map(item => { const id = Number(item.id); const quantity = Number(item.quantity); if (!Number.isInteger(id) || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) throw new HttpError("بيانات منتج غير صالحة.", 400); return { id, quantity }; });
}
function normalizeKuwaitMobile(value) { const digits = String(value).replace(/\D/g, ""); return digits.startsWith("965") ? digits.slice(3) : digits; }
function clean(value, max) { return String(value || "").trim().slice(0, max); }
function roundKwd(value) { return Math.round(Number(value) * 1000) / 1000; }
function requireConfig(env, names) { const missing = names.filter(name => !env[name]); if (missing.length) throw new HttpError(`إعداد ناقص: ${missing.join(", ")}`, 503); }
async function readJson(request) { try { return await request.json(); } catch { throw new HttpError("بيانات الطلب غير صالحة.", 400); } }
async function verifyHmac(message, supplied, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)));
  return timingSafeEqual(supplied.trim().toLowerCase(), hex) || timingSafeEqual(supplied.trim(), base64);
}
function timingSafeEqual(a, b) { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; }
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }); }
class HttpError extends Error { constructor(message, status) { super(message); this.status = status; } }
