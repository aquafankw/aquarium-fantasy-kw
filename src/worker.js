const SITE_URL = "https://www.aquafankw.com";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/products.json") {
        if (url.searchParams.get("source") === "assets") return env.ASSETS.fetch(request);
        return json(await loadProducts(env, request.url));
      }
      if (url.pathname.startsWith("/admin/api/")) return await handleAdminApi(request, env, url);
      if (url.pathname === "/api/create-payment") {
        if (request.method !== "POST") return json({ ok: false, error: "Method Not Allowed" }, 405);
        return await createPayment(request, env);
      }
      if ((request.method === "GET" || request.method === "POST") && url.pathname === "/api/verify-payment") return await verifyPayment(request, env);
      if (request.method === "POST" && url.pathname === "/api/myfatoorah/webhook") return await handleWebhook(request, env);
      if (url.pathname === "/payment-success") return env.ASSETS.fetch(new URL("/payment-success.html", url));
      if (url.pathname === "/payment-failed") return env.ASSETS.fetch(new URL("/payment-failed.html", url));
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(error);
      return json({ ok: false, error: error instanceof HttpError ? error.message : "Ø­Ø¯Ø« Ø®Ø·Ø£ ØºÙŠØ± Ù…ØªÙˆÙ‚Ø¹. Ø­Ø§ÙˆÙ„ÙŠ Ù…Ø±Ø© Ø£Ø®Ø±Ù‰." }, error instanceof HttpError ? error.status : 500);
    }
  }
};

async function createPayment(request, env) {
  requireConfig(env, ["MYFATOORAH_API_KEY", "MYFATOORAH_BASE_URL", "DB"]);
  const body = await readJson(request);
  const customer = validateCustomer(body.customer || {
    name: body.customerName || body.name,
    phone: body.customerPhone || body.phone,
    email: body.customerEmail || body.email,
    address: body.customerAddress || body.address
  });
  const requestedItems = validateRequestedItems(body.items);
  const products = await loadProducts(env, request.url);
  const productMap = new Map(products.map(product => [Number(product.id), product]));
  const items = requestedItems.map(item => {
    const product = productMap.get(item.id);
    if (!product || Number(product.stock) <= 0 || product.isAvailable === false) throw new HttpError("Ø£Ø­Ø¯ Ø§Ù„Ù…Ù†ØªØ¬Ø§Øª ØºÙŠØ± Ù…ØªÙˆÙØ±.", 400);
    if (item.quantity > Number(product.stock)) throw new HttpError("Ø§Ù„ÙƒÙ…ÙŠØ© Ø§Ù„Ù…Ø·Ù„ÙˆØ¨Ø© ØºÙŠØ± Ù…ØªÙˆÙØ±Ø©.", 400);
    const unitPrice = roundKwd(product.price);
    if (!Number.isFinite(unitPrice) || unitPrice < 0) throw new HttpError("Ø³Ø¹Ø± Ù…Ù†ØªØ¬ ØºÙŠØ± ØµØ§Ù„Ø­.", 500);
    return { id: item.id, quantity: item.quantity, unitPrice, name: String(product.nameAr || product.nameEn || `Product ${item.id}`).slice(0, 100) };
  });
  const subtotal = roundKwd(items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0));
  const deliveryFee = 0;
  const total = roundKwd(subtotal + deliveryFee);
  if (total <= 0) throw new HttpError("Ù‚ÙŠÙ…Ø© Ø§Ù„Ø·Ù„Ø¨ ØºÙŠØ± ØµØ§Ù„Ø­Ø©.", 400);

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
  if (!invoiceURL) throw new HttpError("Ù„Ù… ÙŠØªÙ… Ø¥Ù†Ø´Ø§Ø¡ Ø±Ø§Ø¨Ø· Ø§Ù„Ø¯ÙØ¹.", 502);
  await env.DB.prepare("UPDATE orders SET invoice_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(String(invoiceId || ""), orderId).run();
  return json({ ok: true, orderId, invoiceURL });
}

async function verifyPayment(request, env) {
  requireConfig(env, ["MYFATOORAH_API_KEY", "MYFATOORAH_BASE_URL", "DB"]);
  const url = new URL(request.url);
  const body = request.method === "POST" ? await readJson(request) : {};
  const paymentId = String(url.searchParams.get("paymentId") || body.paymentId || "").trim();
  if (!paymentId || paymentId.length > 150) throw new HttpError("Ø±Ù‚Ù… Ø§Ù„Ø¯ÙØ¹ ØºÙŠØ± ØµØ§Ù„Ø­.", 400);
  const response = await myFatoorah(env, "/v2/GetPaymentStatus", { Key: paymentId, KeyType: "PaymentId" });
  const data = response?.Data || {};
  const paid = String(data.InvoiceStatus || "").toUpperCase() === "PAID";
  const orderId = String(data.CustomerReference || "");
  if (orderId) {
    await updatePaymentAndNotify(env, {
      orderId,
      status: paid ? "PAID" : "FAILED",
      paymentId,
      invoiceId: String(data.InvoiceId || "")
    });
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
  if (orderId) await updatePaymentAndNotify(env, { orderId, status, paymentId, invoiceId });
  return new Response("OK", { status: 200 });
}

async function updatePaymentAndNotify(env, { orderId, status, paymentId, invoiceId }) {
  await env.DB.prepare("UPDATE orders SET status=?,payment_id=COALESCE(NULLIF(?,''),payment_id),invoice_id=COALESCE(NULLIF(?,''),invoice_id),updated_at=CURRENT_TIMESTAMP WHERE id=?")
    .bind(status, paymentId, invoiceId, orderId).run();

  if (status !== "PAID") return;
  try {
    await sendPaidOrderEmailOnce(env, orderId);
  } catch (error) {
    console.error("Paid order email error", orderId, error);
  }
}

async function sendPaidOrderEmailOnce(env, orderId) {
  if (!env.SEND_EMAIL) {
    console.error("SEND_EMAIL binding is missing");
    return;
  }

  const order = await env.DB.prepare(`SELECT id, customer_name, customer_phone, customer_address, items_json, subtotal, delivery_fee, total, payment_id, created_at FROM orders WHERE id=? AND status='PAID'`)
    .bind(orderId).first();
  if (!order) return;

  const claim = await env.DB.prepare("INSERT OR IGNORE INTO order_email_notifications (order_id) VALUES (?)")
    .bind(orderId).run();
  if (Number(claim?.meta?.changes || 0) !== 1) return;

  try {
    const items = safeJson(order.items_json, []);
    const itemLines = items.map(item => `- ${item.name} Ã— ${item.quantity} â€” ${roundKwd(Number(item.unitPrice) * Number(item.quantity)).toFixed(3)} Ø¯.Ùƒ`).join("\n");
    const itemRows = items.map(item => {
      const quantity = Number(item.quantity);
      const unitPrice = Number(item.unitPrice);
      return `<tr>
        <td style="padding:10px;border:1px solid #d8e4e8;text-align:right">${escapeHtml(item.name)}</td>
        <td style="padding:10px;border:1px solid #d8e4e8;text-align:center">${quantity}</td>
        <td style="padding:10px;border:1px solid #d8e4e8;text-align:center;white-space:nowrap">${unitPrice.toFixed(3)} Ø¯.Ùƒ</td>
        <td style="padding:10px;border:1px solid #d8e4e8;text-align:center;white-space:nowrap">${roundKwd(unitPrice * quantity).toFixed(3)} Ø¯.Ùƒ</td>
      </tr>`;
    }).join("");
    const text = [
      "ØªÙ… Ø§Ø³ØªÙ„Ø§Ù… Ø·Ù„Ø¨ Ù…Ø¯ÙÙˆØ¹ Ø¬Ø¯ÙŠØ¯ ÙÙŠ Aquafan Kuwait.",
      "",
      `Ø±Ù‚Ù… Ø§Ù„Ø·Ù„Ø¨: ${order.id}`,
      `Ø§Ø³Ù… Ø§Ù„Ø¹Ù…ÙŠÙ„: ${order.customer_name}`,
      `Ø§Ù„Ù‡Ø§ØªÙ: ${order.customer_phone}`,
      `Ø§Ù„Ø¹Ù†ÙˆØ§Ù†: ${order.customer_address}`,
      "",
      "Ø§Ù„Ù…Ù†ØªØ¬Ø§Øª:",
      itemLines || "Ù„Ø§ ØªÙˆØ¬Ø¯ ØªÙØ§ØµÙŠÙ„ Ù…Ù†ØªØ¬Ø§Øª.",
      "",
      `Ø¥Ø¬Ù…Ø§Ù„ÙŠ Ø§Ù„Ù…Ù†ØªØ¬Ø§Øª: ${Number(order.subtotal).toFixed(3)} Ø¯.Ùƒ`,
      `Ø±Ø³ÙˆÙ… Ø§Ù„ØªÙˆØµÙŠÙ„: ${Number(order.delivery_fee).toFixed(3)} Ø¯.Ùƒ`,
      `Ø§Ù„Ø¥Ø¬Ù…Ø§Ù„ÙŠ Ø§Ù„Ù…Ø¯ÙÙˆØ¹: ${Number(order.total).toFixed(3)} Ø¯.Ùƒ`,
      `Payment ID: ${order.payment_id || "-"}`,
      "",
      `ÙØªØ­ Ù„ÙˆØ­Ø© Ø§Ù„ØªØ­ÙƒÙ…: ${SITE_URL}/admin/`
    ].join("\n");

    const html = `<!doctype html>
<html lang="ar" dir="rtl">
<body style="margin:0;background:#f3f8f9;font-family:Arial,Tahoma,sans-serif;color:#17353d">
  <div style="max-width:700px;margin:0 auto;padding:24px 12px">
    <div style="background:#0b5f73;color:#fff;padding:22px;border-radius:14px 14px 0 0;text-align:center">
      <div style="font-size:13px;opacity:.85">Aquafan Kuwait</div>
      <h1 style="margin:7px 0 0;font-size:25px">Ø·Ù„Ø¨ Ù…Ø¯ÙÙˆØ¹ Ø¬Ø¯ÙŠØ¯</h1>
    </div>
    <div style="background:#fff;padding:22px;border:1px solid #d8e4e8;border-top:0;border-radius:0 0 14px 14px">
      <table role="presentation" style="width:100%;border-collapse:collapse;margin-bottom:22px;font-size:15px">
        <tr><th style="width:34%;padding:10px;border:1px solid #d8e4e8;background:#edf6f7;text-align:right">Ø±Ù‚Ù… Ø§Ù„Ø·Ù„Ø¨</th><td style="padding:10px;border:1px solid #d8e4e8;font-weight:bold">${escapeHtml(order.id)}</td></tr>
        <tr><th style="padding:10px;border:1px solid #d8e4e8;background:#edf6f7;text-align:right">Ø§Ø³Ù… Ø§Ù„Ø¹Ù…ÙŠÙ„</th><td style="padding:10px;border:1px solid #d8e4e8">${escapeHtml(order.customer_name)}</td></tr>
        <tr><th style="padding:10px;border:1px solid #d8e4e8;background:#edf6f7;text-align:right">Ø±Ù‚Ù… Ø§Ù„Ù‡Ø§ØªÙ</th><td style="padding:10px;border:1px solid #d8e4e8;direction:ltr;text-align:right">${escapeHtml(order.customer_phone)}</td></tr>
        <tr><th style="padding:10px;border:1px solid #d8e4e8;background:#edf6f7;text-align:right">Ø§Ù„Ø¹Ù†ÙˆØ§Ù†</th><td style="padding:10px;border:1px solid #d8e4e8;line-height:1.7">${escapeHtml(order.customer_address)}</td></tr>
        <tr><th style="padding:10px;border:1px solid #d8e4e8;background:#edf6f7;text-align:right">Ø­Ø§Ù„Ø© Ø§Ù„Ø¯ÙØ¹</th><td style="padding:10px;border:1px solid #d8e4e8;color:#08783e;font-weight:bold">PAID âœ“</td></tr>
      </table>
      <h2 style="font-size:19px;margin:0 0 10px">Ø§Ù„Ù…Ù†ØªØ¬Ø§Øª</h2>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <thead><tr style="background:#0b5f73;color:#fff">
            <th style="padding:10px;border:1px solid #0b5f73;text-align:right">Ø§Ù„Ù…Ù†ØªØ¬</th>
            <th style="padding:10px;border:1px solid #0b5f73">Ø§Ù„ÙƒÙ…ÙŠØ©</th>
            <th style="padding:10px;border:1px solid #0b5f73">Ø³Ø¹Ø± Ø§Ù„ÙˆØ­Ø¯Ø©</th>
            <th style="padding:10px;border:1px solid #0b5f73">Ø§Ù„Ø¥Ø¬Ù…Ø§Ù„ÙŠ</th>
          </tr></thead>
          <tbody>${itemRows || `<tr><td colspan="4" style="padding:12px;border:1px solid #d8e4e8;text-align:center">Ù„Ø§ ØªÙˆØ¬Ø¯ ØªÙØ§ØµÙŠÙ„ Ù…Ù†ØªØ¬Ø§Øª</td></tr>`}</tbody>
        </table>
      </div>
      <table role="presentation" style="width:100%;border-collapse:collapse;margin-top:22px;font-size:15px">
        <tr><th style="padding:10px;border:1px solid #d8e4e8;background:#edf6f7;text-align:right">Ø¥Ø¬Ù…Ø§Ù„ÙŠ Ø§Ù„Ù…Ù†ØªØ¬Ø§Øª</th><td style="padding:10px;border:1px solid #d8e4e8;white-space:nowrap">${Number(order.subtotal).toFixed(3)} Ø¯.Ùƒ</td></tr>
        <tr><th style="padding:10px;border:1px solid #d8e4e8;background:#edf6f7;text-align:right">Ø±Ø³ÙˆÙ… Ø§Ù„ØªÙˆØµÙŠÙ„</th><td style="padding:10px;border:1px solid #d8e4e8;white-space:nowrap">${Number(order.delivery_fee).toFixed(3)} Ø¯.Ùƒ</td></tr>
        <tr><th style="padding:12px;border:1px solid #0b5f73;background:#0b5f73;color:#fff;text-align:right">Ø§Ù„Ø¥Ø¬Ù…Ø§Ù„ÙŠ Ø§Ù„Ù…Ø¯ÙÙˆØ¹</th><td style="padding:12px;border:1px solid #0b5f73;background:#0b5f73;color:#fff;font-size:18px;font-weight:bold;white-space:nowrap">${Number(order.total).toFixed(3)} Ø¯.Ùƒ</td></tr>
      </table>
      <div style="text-align:center;margin-top:24px">
        <a href="${SITE_URL}/admin/" style="display:inline-block;background:#139b62;color:#fff;text-decoration:none;padding:12px 24px;border-radius:9px;font-weight:bold">ÙØªØ­ Ù„ÙˆØ­Ø© Ø§Ù„ØªØ­ÙƒÙ…</a>
      </div>
    </div>
  </div>
</body>
</html>`;

    await env.SEND_EMAIL.send({
      from: "Aquafan Orders <orders@aquafankw.com>",
      to: "aquafankw@hotmail.com",
      subject: `Ø·Ù„Ø¨ Ù…Ø¯ÙÙˆØ¹ Ø¬Ø¯ÙŠØ¯ - ${order.id}`,
      text,
      html
    });
  } catch (error) {
    await env.DB.prepare("DELETE FROM order_email_notifications WHERE order_id=?").bind(orderId).run();
    throw error;
  }
}

async function handleAdminApi(request, env, url) {
  requireConfig(env, ["DB"]);
  if (request.method === "GET" && url.pathname === "/admin/api/orders") {
    const result = await env.DB.prepare(`SELECT o.*, COALESCE(d.delivery_status, 'NEW') AS delivery_status, COALESCE(d.tracking_url, '') AS tracking_url FROM orders o LEFT JOIN order_delivery d ON d.order_id=o.id ORDER BY o.created_at DESC LIMIT 200`).all();
    return json({ ok: true, orders: result.results || [] });
  }
  if (request.method === "GET" && url.pathname === "/admin/api/products") return json({ ok: true, products: await loadProducts(env, request.url) });
  const productMatch = url.pathname.match(/^\/admin\/api\/products\/(\d+)$/);
  if (request.method === "PATCH" && productMatch) return updateProductOverride(request, env, Number(productMatch[1]), url);
  const deliveryMatch = url.pathname.match(/^\/admin\/api\/orders\/([^/]+)\/delivery$/);
  if (request.method === "PATCH" && deliveryMatch) return updateDelivery(request, env, decodeURIComponent(deliveryMatch[1]));
  return json({ ok: false, error: "Ø§Ù„Ù…Ø³Ø§Ø± ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯." }, 404);
}

async function updateProductOverride(request, env, productId, url) {
  const products = await loadProducts(env, url.toString());
  if (!products.some(product => Number(product.id) === productId)) throw new HttpError("Ø§Ù„Ù…Ù†ØªØ¬ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯.", 404);
  const body = await readJson(request);
  const stock = Number(body.stock);
  const price = Number(body.price);
  const isAvailable = body.isAvailable ? 1 : 0;
  if (!Number.isInteger(stock) || stock < 0 || stock > 100000) throw new HttpError("Ø§Ù„ÙƒÙ…ÙŠØ© ØºÙŠØ± ØµØ§Ù„Ø­Ø©.", 400);
  if (!Number.isFinite(price) || price < 0 || price > 100000) throw new HttpError("Ø§Ù„Ø³Ø¹Ø± ØºÙŠØ± ØµØ§Ù„Ø­.", 400);
  await env.DB.prepare(`INSERT INTO product_overrides (product_id, stock, is_available, price, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(product_id) DO UPDATE SET stock=excluded.stock, is_available=excluded.is_available, price=excluded.price, updated_at=CURRENT_TIMESTAMP`)
    .bind(productId, stock, isAvailable, roundKwd(price)).run();
  return json({ ok: true });
}

async function updateDelivery(request, env, orderId) {
  const body = await readJson(request);
  const status = String(body.status || "NEW").toUpperCase();
  const trackingUrl = clean(body.trackingUrl, 500);
  const allowed = ["NEW", "PREPARING", "READY", "SENT_TO_ARMADA", "ACCEPTED", "DISPATCHED", "EN_ROUTE", "COMPLETED", "FAILED", "CANCELED"];
  if (!allowed.includes(status)) throw new HttpError("Ø­Ø§Ù„Ø© Ø§Ù„ØªÙˆØµÙŠÙ„ ØºÙŠØ± ØµØ§Ù„Ø­Ø©.", 400);
  const exists = await env.DB.prepare("SELECT id FROM orders WHERE id=?").bind(orderId).first();
  if (!exists) throw new HttpError("Ø§Ù„Ø·Ù„Ø¨ ØºÙŠØ± Ù…ÙˆØ¬ÙˆØ¯.", 404);
  await env.DB.prepare(`INSERT INTO order_delivery (order_id, delivery_status, tracking_url, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(order_id) DO UPDATE SET delivery_status=excluded.delivery_status, tracking_url=excluded.tracking_url, updated_at=CURRENT_TIMESTAMP`)
    .bind(orderId, status, trackingUrl).run();
  return json({ ok: true });
}

async function loadProducts(env, requestUrl) {
  const response = await env.ASSETS.fetch(new URL("/products.json?source=assets", requestUrl));
  if (!response.ok) throw new HttpError("ØªØ¹Ø°Ù‘Ø± ØªØ­Ù…ÙŠÙ„ Ù‚Ø§Ø¦Ù…Ø© Ø§Ù„Ù…Ù†ØªØ¬Ø§Øª.", 500);
  const products = await response.json();
  const overrides = await env.DB.prepare("SELECT product_id, stock, is_available, price FROM product_overrides").all();
  const overrideMap = new Map((overrides.results || []).map(row => [Number(row.product_id), row]));
  return products.map(product => {
    const override = overrideMap.get(Number(product.id));
    if (!override) return { ...product, isAvailable: Number(product.stock) > 0 };
    return { ...product, stock: Number(override.stock), price: Number(override.price), isAvailable: Boolean(override.is_available) && Number(override.stock) > 0 };
  });
}

async function myFatoorah(env, path, payload) {
  const base = String(env.MYFATOORAH_BASE_URL).replace(/\/$/, "");
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { Authorization: `Bearer ${env.MYFATOORAH_API_KEY}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(payload) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.IsSuccess === false) {
    console.error("MyFatoorah error", response.status, result);
    throw new HttpError(result.Message || "ØªØ¹Ø°Ù‘Ø± Ø§Ù„Ø§ØªØµØ§Ù„ Ø¨Ø®Ø¯Ù…Ø© Ø§Ù„Ø¯ÙØ¹.", 502);
  }
  return result;
}

function validateCustomer(value = {}) {
  const customer = { name: clean(value.name, 100), phone: clean(value.phone, 20), email: clean(value.email, 150), governorate: clean(value.governorate, 60), area: clean(value.area, 80), block: clean(value.block, 20), street: clean(value.street, 100), avenue: clean(value.avenue, 60), building: clean(value.building, 40), floor: clean(value.floor, 20), apartment: clean(value.apartment, 20), notes: clean(value.notes, 200), address: clean(value.address, 500) };
  if (customer.name.length < 2) throw new HttpError("Ø§ÙƒØªØ¨ÙŠ Ø§Ø³Ù… Ø§Ù„Ø¹Ù…ÙŠÙ„.", 400);
  if (!/^\+?\d[\d\s-]{6,18}$/.test(customer.phone)) throw new HttpError("Ø±Ù‚Ù… Ø§Ù„Ù‡Ø§ØªÙ ØºÙŠØ± ØµØ§Ù„Ø­.", 400);
  if (customer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) throw new HttpError("Ø§Ù„Ø¨Ø±ÙŠØ¯ Ø§Ù„Ø¥Ù„ÙƒØªØ±ÙˆÙ†ÙŠ ØºÙŠØ± ØµØ§Ù„Ø­.", 400);
  if (!customer.address) {
    if (!customer.governorate || !customer.area || !customer.block || !customer.street || !customer.building) throw new HttpError("Ø£ÙƒÙ…Ù„ÙŠ Ø§Ù„Ù…Ø­Ø§ÙØ¸Ø© ÙˆØ§Ù„Ù…Ù†Ø·Ù‚Ø© ÙˆØ§Ù„Ù‚Ø·Ø¹Ø© ÙˆØ§Ù„Ø´Ø§Ø±Ø¹ ÙˆØ§Ù„Ù…Ù†Ø²Ù„ Ø£Ùˆ Ø§Ù„Ù…Ø¨Ù†Ù‰.", 400);
    customer.address = [`Ø§Ù„Ù…Ø­Ø§ÙØ¸Ø©: ${customer.governorate}`, `Ø§Ù„Ù…Ù†Ø·Ù‚Ø©: ${customer.area}`, `Ø§Ù„Ù‚Ø·Ø¹Ø©: ${customer.block}`, `Ø§Ù„Ø´Ø§Ø±Ø¹: ${customer.street}`, customer.avenue && `Ø§Ù„Ø¬Ø§Ø¯Ø©: ${customer.avenue}`, `Ø§Ù„Ù…Ù†Ø²Ù„/Ø§Ù„Ù…Ø¨Ù†Ù‰: ${customer.building}`, customer.floor && `Ø§Ù„Ø¯ÙˆØ±: ${customer.floor}`, customer.apartment && `Ø§Ù„Ø´Ù‚Ø©: ${customer.apartment}`, customer.notes && `Ù…Ù„Ø§Ø­Ø¸Ø§Øª: ${customer.notes}`].filter(Boolean).join("ØŒ ");
  }
  return customer;
}
function validateRequestedItems(items) { if (!Array.isArray(items) || !items.length || items.length > 100) throw new HttpError("Ø§Ù„Ø³Ù„Ø© ÙØ§Ø±ØºØ© Ø£Ùˆ ØºÙŠØ± ØµØ§Ù„Ø­Ø©.", 400); return items.map(item => { const id = Number(item.id); const quantity = Number(item.quantity); if (!Number.isInteger(id) || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) throw new HttpError("Ø¨ÙŠØ§Ù†Ø§Øª Ù…Ù†ØªØ¬ ØºÙŠØ± ØµØ§Ù„Ø­Ø©.", 400); return { id, quantity }; }); }
function normalizeKuwaitMobile(value) { const digits = String(value).replace(/\D/g, ""); return digits.startsWith("965") ? digits.slice(3) : digits; }
function safeJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character])); }
function clean(value, max) { return String(value || "").trim().slice(0, max); }
function roundKwd(value) { return Math.round(Number(value) * 1000) / 1000; }
function requireConfig(env, names) { const missing = names.filter(name => !env[name]); if (missing.length) throw new HttpError(`Ø¥Ø¹Ø¯Ø§Ø¯ Ù†Ø§Ù‚Øµ: ${missing.join(", ")}`, 503); }
async function readJson(request) { try { return await request.json(); } catch { throw new HttpError("Ø¨ÙŠØ§Ù†Ø§Øª Ø§Ù„Ø·Ù„Ø¨ ØºÙŠØ± ØµØ§Ù„Ø­Ø©.", 400); } }
async function verifyHmac(message, supplied, secret) { const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)); const bytes = new Uint8Array(digest); const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join(""); const base64 = btoa(String.fromCharCode(...bytes)); return timingSafeEqual(supplied.trim().toLowerCase(), hex) || timingSafeEqual(supplied.trim(), base64); }
function timingSafeEqual(a, b) { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; }
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }); }
class HttpError extends Error { constructor(message, status) { super(message); this.name = "HttpError"; this.message = message; this.status = status; } }
