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
      return json({ ok: false, error: error instanceof HttpError ? error.message : "حدث خطأ غير متوقع. حاولي مرة أخرى." }, error instanceof HttpError ? error.status : 500);
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
    if (!product || Number(product.stock) <= 0 || product.isAvailable === false) throw new HttpError("أحد المنتجات غير متوفر.", 400);
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
await env.DB.prepare(`
  INSERT INTO orders (
    id,
    status,
    customer_name,
    customer_phone,
    customer_email,
    customer_address,
    customer_governorate,
    customer_area,
    customer_block,
    customer_street,
    customer_avenue,
    customer_building,
    customer_floor,
    customer_apartment,
    customer_notes,
    items_json,
    subtotal,
    delivery_fee,
    total
  )
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`)
  .bind(
    orderId,
    "PENDING",
    customer.name,
    customer.phone,
    customer.email,
    customer.address,
    customer.governorate,
    customer.area,
    customer.block,
    customer.street,
    customer.avenue,
    customer.building,
    customer.floor,
    customer.apartment,
    customer.notes,
    JSON.stringify(items),
    subtotal,
    deliveryFee,
    total
  )
  .run();
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
    const productCatalog = await loadProducts(env, SITE_URL);
    const imageByProductId = new Map(productCatalog.map(product => [Number(product.id), absoluteProductImage(product.image)]));
    const itemLines = items.map(item => `- ${item.name}: ${item.quantity} × ${Number(item.unitPrice).toFixed(3)} د.ك`).join("\n");
    const itemRows = items.map(item => {
      const quantity = Number(item.quantity);
      const unitPrice = Number(item.unitPrice);
      const imageUrl = imageByProductId.get(Number(item.id)) || "";
      return `<table role="presentation" dir="rtl" style="width:100%;max-width:100%;border-collapse:collapse;margin:0 0 12px;font-size:14px;table-layout:fixed">
        <tr>
          <td style="width:88px;padding:9px;border:1px solid #d8e4e8;background:#f8fbfc;text-align:center">
            ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" width="70" height="70" alt="${escapeHtml(item.name)}" style="display:block;width:70px;height:70px;margin:auto;object-fit:cover;border-radius:8px">` : ""}
          </td>
          <td style="padding:12px;border:1px solid #d8e4e8;text-align:right;overflow-wrap:anywhere">
            <div style="font-size:15px;font-weight:bold;margin-bottom:8px">${escapeHtml(item.name)}</div>
            <div style="color:#355d66">${quantity} × ${unitPrice.toFixed(3)} د.ك</div>
          </td>
        </tr>
      </table>`;
    }).join("");
    const text = [
      "تم استلام طلب مدفوع جديد في Aquafan Kuwait.",
      "",
      `رقم الطلب: ${order.id}`,
      `اسم العميل: ${order.customer_name}`,
      `الهاتف: ${order.customer_phone}`,
      `العنوان: ${order.customer_address}`,
      "",
      "المنتجات:",
      itemLines || "لا توجد تفاصيل منتجات.",
      "",
      `إجمالي المنتجات: ${Number(order.subtotal).toFixed(3)} د.ك`,
      `رسوم التوصيل: ${Number(order.delivery_fee).toFixed(3)} د.ك`,
      `الإجمالي المدفوع: ${Number(order.total).toFixed(3)} د.ك`,
      `Payment ID: ${order.payment_id || "-"}`,
      "",
      `فتح لوحة التحكم: ${SITE_URL}/admin/`
    ].join("\n");

    const html = `<!doctype html>
<html lang="ar" dir="rtl">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body dir="rtl" style="margin:0;background:#f3f8f9;font-family:Tahoma,Arial,sans-serif;color:#17353d;text-align:right">
  <div dir="rtl" style="width:100%;max-width:600px;box-sizing:border-box;margin:0 auto;padding:16px 8px">
    <div style="background:#0b5f73;color:#fff;padding:22px;border-radius:14px 14px 0 0;text-align:center">
      <div style="font-size:13px;opacity:.85">Aquafan Kuwait</div>
      <h1 style="margin:7px 0 0;font-size:25px">طلب مدفوع جديد</h1>
    </div>
    <div dir="rtl" style="background:#fff;padding:14px;box-sizing:border-box;border:1px solid #d8e4e8;border-top:0;border-radius:0 0 14px 14px">
      <table role="presentation" dir="rtl" style="width:100%;max-width:100%;table-layout:fixed;border-collapse:collapse;margin-bottom:20px;font-size:14px">
        <tr><th style="width:34%;padding:9px;border:1px solid #d8e4e8;background:#edf6f7;text-align:right">رقم الطلب</th><td style="padding:9px;border:1px solid #d8e4e8;font-weight:bold;overflow-wrap:anywhere">${escapeHtml(order.id)}</td></tr>
        <tr><th style="padding:10px;border:1px solid #d8e4e8;background:#edf6f7;text-align:right">اسم العميل</th><td style="padding:10px;border:1px solid #d8e4e8">${escapeHtml(order.customer_name)}</td></tr>
        <tr><th style="padding:10px;border:1px solid #d8e4e8;background:#edf6f7;text-align:right">رقم الهاتف</th><td style="padding:10px;border:1px solid #d8e4e8;direction:ltr;text-align:right">${escapeHtml(order.customer_phone)}</td></tr>
        <tr><th style="padding:10px;border:1px solid #d8e4e8;background:#edf6f7;text-align:right">العنوان</th><td style="padding:10px;border:1px solid #d8e4e8;line-height:1.7">${escapeHtml(order.customer_address)}</td></tr>
        <tr><th style="padding:10px;border:1px solid #d8e4e8;background:#edf6f7;text-align:right">حالة الدفع</th><td style="padding:10px;border:1px solid #d8e4e8;color:#08783e;font-weight:bold">مدفوع ✓</td></tr>
      </table>
      <h2 style="font-size:19px;margin:0 0 10px">المنتجات</h2>
      <div dir="rtl" style="width:100%;max-width:100%">${itemRows || `<p style="padding:12px;border:1px solid #d8e4e8;text-align:center">لا توجد تفاصيل منتجات</p>`}</div>
      <table role="presentation" dir="rtl" style="width:100%;max-width:100%;table-layout:fixed;border-collapse:collapse;margin-top:20px;font-size:14px">
        <tr><th style="padding:10px;border:1px solid #d8e4e8;background:#edf6f7;text-align:right">إجمالي المنتجات</th><td style="padding:10px;border:1px solid #d8e4e8;white-space:nowrap">${Number(order.subtotal).toFixed(3)} د.ك</td></tr>
        <tr><th style="padding:10px;border:1px solid #d8e4e8;background:#edf6f7;text-align:right">رسوم التوصيل</th><td style="padding:10px;border:1px solid #d8e4e8;white-space:nowrap">${Number(order.delivery_fee).toFixed(3)} د.ك</td></tr>
        <tr><th style="padding:12px;border:1px solid #0b5f73;background:#0b5f73;color:#fff;text-align:right">الإجمالي المدفوع</th><td style="padding:12px;border:1px solid #0b5f73;background:#0b5f73;color:#fff;font-size:18px;font-weight:bold;white-space:nowrap">${Number(order.total).toFixed(3)} د.ك</td></tr>
      </table>
      <div style="text-align:center;margin-top:24px">
        <a href="${SITE_URL}/admin/" style="display:inline-block;background:#139b62;color:#fff;text-decoration:none;padding:12px 24px;border-radius:9px;font-weight:bold">فتح لوحة التحكم</a>
      </div>
    </div>
  </div>
</body>
</html>`;

    await env.SEND_EMAIL.send({
      from: "Aquafan Orders <orders@aquafankw.com>",
      to: "aquafankw@hotmail.com",
      subject: `طلب مدفوع جديد - ${order.id}`,
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
  if (request.method === "PATCH" && deliveryMatch) return updateDelivery(request, env, decodeURIComponent(deliveryMatch[1]));const armadaMatch = url.pathname.match(
  /^\/admin\/api\/orders\/([^/]+)\/send-armada$/
);

if (request.method === "POST" && armadaMatch) {
  return sendOrderToArmada(
    request,
    env,
    decodeURIComponent(armadaMatch[1])
  );
}
  return json({ ok: false, error: "المسار غير موجود." }, 404);
}

async function updateProductOverride(request, env, productId, url) {
  const products = await loadProducts(env, url.toString());
  if (!products.some(product => Number(product.id) === productId)) throw new HttpError("المنتج غير موجود.", 404);
  const body = await readJson(request);
  const stock = Number(body.stock);
  const price = Number(body.price);
  const isAvailable = body.isAvailable ? 1 : 0;
  if (!Number.isInteger(stock) || stock < 0 || stock > 100000) throw new HttpError("الكمية غير صالحة.", 400);
  if (!Number.isFinite(price) || price < 0 || price > 100000) throw new HttpError("السعر غير صالح.", 400);
  await env.DB.prepare(`INSERT INTO product_overrides (product_id, stock, is_available, price, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(product_id) DO UPDATE SET stock=excluded.stock, is_available=excluded.is_available, price=excluded.price, updated_at=CURRENT_TIMESTAMP`)
    .bind(productId, stock, isAvailable, roundKwd(price)).run();
  return json({ ok: true });
}

async function sendOrderToArmada(request, env, orderId) {
  requireConfig(env, [
    "DB",
    "ARMADA_API_KEY",
    "ARMADA_API_SECRET",
    "ARMADA_BRANCH_ID"
  ]);

  const order = await env.DB
    .prepare("SELECT * FROM orders WHERE id = ?")
    .bind(orderId)
    .first();

  if (!order) {
    throw new HttpError("الطلب غير موجود.", 404);
  }

  if (order.status !== "PAID") {
    throw new HttpError(
      "لا يمكن إرسال الطلب قبل تأكيد الدفع.",
      400
    );
  }

  const existing = await env.DB
    .prepare(
      "SELECT armada_delivery_id, tracking_url FROM order_delivery WHERE order_id = ?"
    )
    .bind(orderId)
    .first();

  if (existing?.armada_delivery_id) {
    return json({
      ok: true,
      alreadySent: true,
      trackingUrl: existing.tracking_url || ""
    });
  }

  const input = await readJson(request);

  const area = clean(input.area, 80);
  const block = clean(input.block, 30);
  const street = clean(input.street, 100);
  const building = clean(input.building, 50);
  const floor = clean(input.floor, 30);
  const apartment = clean(input.apartment, 30);
  const instructions = clean(input.instructions, 300);

  if (!area || !block || !street || !building) {
    throw new HttpError(
      "عنوان العميل ناقص. يجب وجود المنطقة والقطعة والشارع والمنزل.",
      400
    );
  }

  const payload = {
    reference: order.id,
    payment: {
      amount: roundKwd(order.total),
      type: "paid"
    },
    origin_format: "branch_format",
    origin: {
      branch_id: env.ARMADA_BRANCH_ID
    },
    destination_format: "kuwait_format",
    destination: {
      contact_name: order.customer_name,
      contact_phone: `+965${normalizeKuwaitMobile(order.customer_phone)}`,
      area,
      block,
      street,
      building,
      floor: floor || undefined,
      apartment: apartment || undefined,
      instructions: instructions || order.customer_address
    }
  };

  const armada = await armadaRequest(
    env,
    "POST",
    "/v2/deliveries",
    payload
  );

  const deliveryId = String(armada.id || "");

  if (!deliveryId) {
    throw new HttpError(
      "Armada لم ترجع رقم طلب التوصيل.",
      502
    );
  }

  const trackingUrl = String(
    armada?.logistics?.tracking_url ||
    armada.trackingLink ||
    ""
  );

  const code = String(armada.code || "");

  await env.DB.prepare(`
    INSERT INTO order_delivery (
      order_id,
      delivery_status,
      tracking_url,
      armada_delivery_id,
      armada_code,
      delivery_fee,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(order_id) DO UPDATE SET
      delivery_status = excluded.delivery_status,
      tracking_url = excluded.tracking_url,
      armada_delivery_id = excluded.armada_delivery_id,
      armada_code = excluded.armada_code,
      delivery_fee = excluded.delivery_fee,
      updated_at = CURRENT_TIMESTAMP
  `)
    .bind(
      order.id,
      String(armada.status || "PENDING").toUpperCase(),
      trackingUrl,
      deliveryId,
      code,
      Number(armada.delivery_fee || 0)
    )
    .run();

  return json({
    ok: true,
    deliveryId,
    code,
    trackingUrl
  });
}

async function armadaRequest(env, method, path, payload) {
  const body = JSON.stringify(payload);
  const timestamp = Date.now().toString();

  const signature = await hmacHex(
    `${timestamp}.${method}.${path}.${body}`,
    env.ARMADA_API_SECRET
  );

  const response = await fetch(
    `https://api.armadadelivery.com${path}`,
    {
      method,
      headers: {
        Authorization: `Key ${env.ARMADA_API_KEY}`,
        "x-armada-timestamp": timestamp,
        "x-armada-signature": signature,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body
    }
  );

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error("Armada error", response.status, result);
    throw new HttpError(
      result.message ||
      result.error ||
      "تعذر إنشاء طلب Armada.",
      502
    );
  }

  return result;
}

async function hmacHex(message, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["sign"]
  );

  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message)
  );

  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}
async function updateDelivery(request, env, orderId) {
  const body = await readJson(request);
  const status = String(body.status || "NEW").toUpperCase();
  const trackingUrl = clean(body.trackingUrl, 500);
  const allowed = ["NEW", "PREPARING", "READY", "SENT_TO_ARMADA", "ACCEPTED", "DISPATCHED", "EN_ROUTE", "COMPLETED", "FAILED", "CANCELED"];
  if (!allowed.includes(status)) throw new HttpError("حالة التوصيل غير صالحة.", 400);
  const exists = await env.DB.prepare("SELECT id FROM orders WHERE id=?").bind(orderId).first();
  if (!exists) throw new HttpError("الطلب غير موجود.", 404);
  await env.DB.prepare(`INSERT INTO order_delivery (order_id, delivery_status, tracking_url, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(order_id) DO UPDATE SET delivery_status=excluded.delivery_status, tracking_url=excluded.tracking_url, updated_at=CURRENT_TIMESTAMP`)
    .bind(orderId, status, trackingUrl).run();
  return json({ ok: true });
}

async function loadProducts(env, requestUrl) {
  const response = await env.ASSETS.fetch(new URL("/products.json?source=assets", requestUrl));
  if (!response.ok) throw new HttpError("تعذّر تحميل قائمة المنتجات.", 500);
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
    throw new HttpError(result.Message || "تعذّر الاتصال بخدمة الدفع.", 502);
  }
  return result;
}

function validateCustomer(value = {}) {
  const customer = { name: clean(value.name, 100), phone: clean(value.phone, 20), email: clean(value.email, 150), governorate: clean(value.governorate, 60), area: clean(value.area, 80), block: clean(value.block, 20), street: clean(value.street, 100), avenue: clean(value.avenue, 60), building: clean(value.building, 40), floor: clean(value.floor, 20), apartment: clean(value.apartment, 20), notes: clean(value.notes, 200), address: clean(value.address, 500) };
  if (customer.name.length < 2) throw new HttpError("اكتبي اسم العميل.", 400);
  if (!/^\+?\d[\d\s-]{6,18}$/.test(customer.phone)) throw new HttpError("رقم الهاتف غير صالح.", 400);
  if (customer.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) throw new HttpError("البريد الإلكتروني غير صالح.", 400);
  if (!customer.address) {
    if (!customer.governorate || !customer.area || !customer.block || !customer.street || !customer.building) throw new HttpError("أكملي المحافظة والمنطقة والقطعة والشارع والمنزل أو المبنى.", 400);
    customer.address = [`المحافظة: ${customer.governorate}`, `المنطقة: ${customer.area}`, `القطعة: ${customer.block}`, `الشارع: ${customer.street}`, customer.avenue && `الجادة: ${customer.avenue}`, `المنزل/المبنى: ${customer.building}`, customer.floor && `الدور: ${customer.floor}`, customer.apartment && `الشقة: ${customer.apartment}`, customer.notes && `ملاحظات: ${customer.notes}`].filter(Boolean).join("، ");
  }
  return customer;
}
function validateRequestedItems(items) { if (!Array.isArray(items) || !items.length || items.length > 100) throw new HttpError("السلة فارغة أو غير صالحة.", 400); return items.map(item => { const id = Number(item.id); const quantity = Number(item.quantity); if (!Number.isInteger(id) || !Number.isInteger(quantity) || quantity < 1 || quantity > 50) throw new HttpError("بيانات منتج غير صالحة.", 400); return { id, quantity }; }); }
function normalizeKuwaitMobile(value) { const digits = String(value).replace(/\D/g, ""); return digits.startsWith("965") ? digits.slice(3) : digits; }
function safeJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character])); }
function absoluteProductImage(value) { const image = String(value || "").trim(); if (!image) return ""; try { return new URL(image.replace(/^\/+/, ""), `${SITE_URL}/`).href; } catch { return ""; } }
function clean(value, max) { return String(value || "").trim().slice(0, max); }
function roundKwd(value) { return Math.round(Number(value) * 1000) / 1000; }
function requireConfig(env, names) { const missing = names.filter(name => !env[name]); if (missing.length) throw new HttpError(`إعداد ناقص: ${missing.join(", ")}`, 503); }
async function readJson(request) { try { return await request.json(); } catch { throw new HttpError("بيانات الطلب غير صالحة.", 400); } }
async function verifyHmac(message, supplied, secret) { const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)); const bytes = new Uint8Array(digest); const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join(""); const base64 = btoa(String.fromCharCode(...bytes)); return timingSafeEqual(supplied.trim().toLowerCase(), hex) || timingSafeEqual(supplied.trim(), base64); }
function timingSafeEqual(a, b) { if (a.length !== b.length) return false; let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i); return diff === 0; }
function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } }); }
class HttpError extends Error { constructor(message, status) { super(message); this.name = "HttpError"; this.message = message; this.status = status; } }

