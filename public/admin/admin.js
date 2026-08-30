const state = { orders: [], products: [], seenPaid: new Set(JSON.parse(localStorage.getItem("aquafanSeenPaid") || "[]")), notifications: false };
const $ = selector => document.querySelector(selector);
const money = value => `${Number(value || 0).toFixed(3)} د.ك`;
const escapeHtml = value => String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[c]));

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || "تعذّر تحميل البيانات.");
  return data;
}
function setMessage(text = "") { $("#message").textContent = text; }
function badge(status) { const cls = String(status).toLowerCase(); return `<span class="badge ${cls}">${escapeHtml(status)}</span>`; }
function readItems(raw) { try { return JSON.parse(raw || "[]"); } catch { return []; } }
function orderCard(order) {
  const items = readItems(order.items_json).map(item => `${escapeHtml(item.name)} × ${item.quantity}`).join("<br>") || "—";
  const deliveryOptions = ["NEW","PREPARING","READY","SENT_TO_ARMADA","ACCEPTED","DISPATCHED","EN_ROUTE","COMPLETED","FAILED","CANCELED"].map(x => `<option ${x === order.delivery_status ? "selected" : ""}>${x}</option>`).join("");
  return `<article class="card"><div class="row"><div><h3>${escapeHtml(order.id)}</h3><div class="muted">${escapeHtml(order.created_at)}<br>${escapeHtml(order.customer_name)} · ${escapeHtml(order.customer_phone)}<br>${escapeHtml(order.customer_address)}</div></div><div>${badge(order.status)}<br><br>${badge(order.delivery_status)}</div></div><div class="items"><b>المنتجات</b><br>${items}<br><br><b>الإجمالي: ${money(order.total)}</b></div><div class="delivery"><select data-delivery-status="${escapeHtml(order.id)}">${deliveryOptions}</select><input data-tracking="${escapeHtml(order.id)}" value="${escapeHtml(order.tracking_url)}" placeholder="رابط تتبع Armada (اختياري)"><button class="save" data-save-delivery="${escapeHtml(order.id)}">حفظ التوصيل</button></div></article>`;
}
function renderOrders() {
  const term = $("#orderSearch").value.trim().toLowerCase();
  const orders = state.orders.filter(o => [o.id,o.customer_name,o.customer_phone,o.customer_address].join(" ").toLowerCase().includes(term));
  $("#orders").innerHTML = orders.length ? orders.map(orderCard).join("") : "<p>لا توجد طلبات حتى الآن.</p>";
}
function productCard(product) {
  const unavailable = !product.isAvailable || Number(product.stock) < 1;
  return `<article class="product ${unavailable ? "out" : ""}"><img src="/${escapeHtml(product.image)}" alt=""><div><h3>${escapeHtml(product.nameAr || product.nameEn)}</h3><div class="muted">#${product.id} · ${escapeHtml(product.category || "")}</div><div class="form-row"><input data-stock="${product.id}" type="number" min="0" value="${Number(product.stock)}" aria-label="الكمية"><input data-price="${product.id}" type="number" min="0" step="0.001" value="${Number(product.price)}" aria-label="السعر"></div><select data-available="${product.id}"><option value="true" ${product.isAvailable ? "selected" : ""}>متوفر</option><option value="false" ${!product.isAvailable ? "selected" : ""}>غير متوفر</option></select><button class="save" data-save-product="${product.id}">حفظ التعديل</button></div></article>`;
}
function renderProducts() {
  const term = $("#productSearch").value.trim().toLowerCase();
  const products = state.products.filter(p => [p.id,p.nameAr,p.nameEn,p.category].join(" ").toLowerCase().includes(term));
  $("#products").innerHTML = products.map(productCard).join("") || "<p>لا توجد منتجات مطابقة.</p>";
}
function renderStats() {
  const paid = state.orders.filter(o => o.status === "PAID");
  const today = new Date().toISOString().slice(0,10);
  const sales = paid.filter(o => String(o.created_at).slice(0,10) === today).reduce((sum,o) => sum + Number(o.total || 0),0);
  const unavailable = state.products.filter(p => !p.isAvailable || Number(p.stock) < 1).length;
  $("#stats").innerHTML = `<div class="stat"><small>كل الطلبات</small><strong>${state.orders.length}</strong></div><div class="stat"><small>طلبات مدفوعة</small><strong>${paid.length}</strong></div><div class="stat"><small>تحت التوصيل</small><strong>${state.orders.filter(o => ["SENT_TO_ARMADA","ACCEPTED","DISPATCHED","EN_ROUTE"].includes(o.delivery_status)).length}</strong></div><div class="stat"><small>مبيعات اليوم</small><strong>${money(sales)}</strong><small>غير متوفر: ${unavailable}</small></div>`;
}
function notifyNewPaid() {
  const paidIds = state.orders.filter(o => o.status === "PAID").map(o => o.id);
  const fresh = paidIds.filter(id => !state.seenPaid.has(id));
  if (state.notifications && Notification.permission === "granted") fresh.forEach(id => { const o = state.orders.find(x => x.id === id); new Notification("طلب مدفوع جديد - Aquafan", { body: `${o.id} · ${o.customer_name} · ${money(o.total)}` }); });
  paidIds.forEach(id => state.seenPaid.add(id));
  localStorage.setItem("aquafanSeenPaid", JSON.stringify([...state.seenPaid].slice(-500)));
}
async function load() {
  try { setMessage("" ); const [orders, products] = await Promise.all([api("/admin/api/orders"), api("/admin/api/products")]); state.orders = orders.orders; state.products = products.products; notifyNewPaid(); renderStats(); renderOrders(); renderProducts(); } catch (e) { setMessage(e.message); }
}
document.addEventListener("click", async event => {
  const productId = event.target.dataset.saveProduct;
  if (productId) { try { const stock = Number(document.querySelector(`[data-stock="${productId}"]`).value); const price = Number(document.querySelector(`[data-price="${productId}"]`).value); const isAvailable = document.querySelector(`[data-available="${productId}"]`).value === "true"; await api(`/admin/api/products/${productId}`, { method:"PATCH", body:JSON.stringify({stock,price,isAvailable}) }); setMessage("تم حفظ المنتج."); await load(); } catch (e) { setMessage(e.message); } }
  const orderId = event.target.dataset.saveDelivery;
  if (orderId) { try { const status = document.querySelector(`[data-delivery-status="${CSS.escape(orderId)}"]`).value; const trackingUrl = document.querySelector(`[data-tracking="${CSS.escape(orderId)}"]`).value; await api(`/admin/api/orders/${encodeURIComponent(orderId)}/delivery`, { method:"PATCH", body:JSON.stringify({status,trackingUrl}) }); setMessage("تم حفظ حالة التوصيل."); await load(); } catch (e) { setMessage(e.message); } }
});
$("#refreshButton").addEventListener("click", load);
$("#orderSearch").addEventListener("input", renderOrders);
$("#productSearch").addEventListener("input", renderProducts);
$("#notifyButton").addEventListener("click", async () => { if (!("Notification" in window)) return setMessage("هذا المتصفح لا يدعم التنبيه."); const permission = await Notification.requestPermission(); state.notifications = permission === "granted"; setMessage(state.notifications ? "تم تفعيل التنبيه أثناء فتح التطبيق." : "لم يتم السماح بالتنبيهات."); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/admin/service-worker.js");
load(); setInterval(load, 30000);
