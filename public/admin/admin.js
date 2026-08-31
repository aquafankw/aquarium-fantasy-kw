const state = { orders: [], products: [], branches: [], seenPaid: new Set(JSON.parse(localStorage.getItem("aquafanSeenPaid") || "[]")), notifications: false };
const $ = selector => document.querySelector(selector);
const money = value => `${Number(value || 0).toFixed(3)} Ø¯.Ùƒ`;
const escapeHtml = value => String(value ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;"}[c]));

async function api(path, options = {}) {
  const response = await fetch(path, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) throw new Error(data.error || "ØªØ¹Ø°Ù‘Ø± ØªØ­Ù…ÙŠÙ„ Ø§Ù„Ø¨ÙŠØ§Ù†Ø§Øª.");
  return data;
}
function setMessage(text = "") { $("#message").textContent = text; }
function badge(status) { const cls = String(status).toLowerCase(); return `<span class="badge ${cls}">${escapeHtml(status)}</span>`; }
function readItems(raw) { try { return JSON.parse(raw || "[]"); } catch { return []; } }
function orderItemRows(raw) {
  const items = readItems(raw);
  if (!items.length) return "â€”";
  return items.map(item => {
    const product = state.products.find(entry => Number(entry.id) === Number(item.id));
    const image = product?.image ? `/${escapeHtml(product.image)}` : "/admin/icon-192.png";
    return `<div class="order-item"><img src="${image}" alt="" loading="lazy"><div><b>${escapeHtml(item.name)}</b><span>Ø§Ù„ÙƒÙ…ÙŠØ©: ${Number(item.quantity || 0)}</span></div></div>`;
  }).join("");
}
function branchOptions(selected = "") {
  return `<option value="">Ø§Ø®ØªØ§Ø±ÙŠ ÙØ±Ø¹ Ø§Ù„Ø§Ø³ØªÙ„Ø§Ù…</option>` + state.branches.map(branch => `<option value="${escapeHtml(branch.id)}" ${branch.id === selected ? "selected" : ""}>${escapeHtml(branch.name)}</option>`).join("");
}
function armadaControls(order) {
  if (order.armada_delivery_code) {
    return `<div class="armada-result"><b>ØªÙ… Ø§Ù„Ø¥Ø±Ø³Ø§Ù„ Ø¥Ù„Ù‰ Armada</b><span>Ø±Ù‚Ù… Ø§Ù„ØªÙˆØµÙŠÙ„: ${escapeHtml(order.armada_delivery_code)} ${order.armada_test_mode ? "Â· ØªØ¬Ø±ÙŠØ¨ÙŠ" : ""}</span>${order.tracking_url ? `<a href="${escapeHtml(order.tracking_url)}" target="_blank" rel="noopener">ÙØªØ­ Ø±Ø§Ø¨Ø· Ø§Ù„ØªØªØ¨Ø¹</a>` : ""}</div>`;
  }
  return `<div class="armada-send"><select data-armada-branch="${escapeHtml(order.id)}">${branchOptions()}</select><button class="armada-button" data-send-armada="${escapeHtml(order.id)}" ${state.branches.length ? "" : "disabled"}>Ø¥Ø±Ø³Ø§Ù„ Ø¥Ù„Ù‰ Armada</button></div>`;
}
function orderCard(order) {
  const items = orderItemRows(order.items_json);
  const statuses = ["NEW","PREPARING","READY","PENDING","SENT_TO_ARMADA","ACCEPTED","DISPATCHED","EN_ROUTE","COMPLETED","FAILED","CANCELED"];
  const deliveryOptions = statuses.map(x => `<option ${x === order.delivery_status ? "selected" : ""}>${x}</option>`).join("");
  return `<article class="card"><div class="row"><div><h3>${escapeHtml(order.id)}</h3><div class="muted">${escapeHtml(order.created_at)}<br>${escapeHtml(order.customer_name)} Â· ${escapeHtml(order.customer_phone)}<br>${escapeHtml(order.customer_address)}</div></div><div>${badge(order.status)}<br><br>${badge(order.delivery_status)}</div></div><div class="items"><b>Ø§Ù„Ù…Ù†ØªØ¬Ø§Øª</b><div class="order-items">${items}</div><b>Ø§Ù„Ø¥Ø¬Ù…Ø§Ù„ÙŠ: ${money(order.total)}</b></div>${armadaControls(order)}<div class="delivery"><select data-delivery-status="${escapeHtml(order.id)}">${deliveryOptions}</select><input data-tracking="${escapeHtml(order.id)}" value="${escapeHtml(order.tracking_url)}" placeholder="Ø±Ø§Ø¨Ø· ØªØªØ¨Ø¹ Armada (Ø§Ø®ØªÙŠØ§Ø±ÙŠ)"><button class="save" data-save-delivery="${escapeHtml(order.id)}">Ø­ÙØ¸ Ø§Ù„ØªÙˆØµÙŠÙ„</button></div></article>`;
}
function renderOrders() {
  const term = $("#orderSearch").value.trim().toLowerCase();
  const orders = state.orders.filter(o => [o.id,o.customer_name,o.customer_phone,o.customer_address].join(" ").toLowerCase().includes(term));
  $("#orders").innerHTML = orders.length ? orders.map(orderCard).join("") : "<p>Ù„Ø§ ØªÙˆØ¬Ø¯ Ø·Ù„Ø¨Ø§Øª Ø­ØªÙ‰ Ø§Ù„Ø¢Ù†.</p>";
}
function productCard(product) {
  const unavailable = !product.isAvailable || Number(product.stock) < 1;
  return `<article class="product ${unavailable ? "out" : ""}"><img src="/${escapeHtml(product.image)}" alt=""><div><h3>${escapeHtml(product.nameAr || product.nameEn)}</h3><div class="muted">#${product.id} Â· ${escapeHtml(product.category || "")}</div><div class="form-row"><input data-stock="${product.id}" type="number" min="0" value="${Number(product.stock)}" aria-label="Ø§Ù„ÙƒÙ…ÙŠØ©"><input data-price="${product.id}" type="number" min="0" step="0.001" value="${Number(product.price)}" aria-label="Ø§Ù„Ø³Ø¹Ø±"></div><select data-available="${product.id}"><option value="true" ${product.isAvailable ? "selected" : ""}>Ù…ØªÙˆÙØ±</option><option value="false" ${!product.isAvailable ? "selected" : ""}>ØºÙŠØ± Ù…ØªÙˆÙØ±</option></select><button class="save" data-save-product="${product.id}">Ø­ÙØ¸ Ø§Ù„ØªØ¹Ø¯ÙŠÙ„</button></div></article>`;
}
function renderProducts() { const term = $("#productSearch").value.trim().toLowerCase(); const products = state.products.filter(p => [p.id,p.nameAr,p.nameEn,p.category].join(" ").toLowerCase().includes(term)); $("#products").innerHTML = products.map(productCard).join("") || "<p>Ù„Ø§ ØªÙˆØ¬Ø¯ Ù…Ù†ØªØ¬Ø§Øª Ù…Ø·Ø§Ø¨Ù‚Ø©.</p>"; }
function renderStats() {
  const paid = state.orders; const today = new Date().toISOString().slice(0,10);
  const sales = paid.filter(o => String(o.created_at).slice(0,10) === today).reduce((sum,o) => sum + Number(o.total || 0),0);
  const unavailable = state.products.filter(p => !p.isAvailable || Number(p.stock) < 1).length;
  $("#stats").innerHTML = `<div class="stat"><small>Ø§Ù„Ø·Ù„Ø¨Ø§Øª Ø§Ù„Ù…Ø¯ÙÙˆØ¹Ø©</small><strong>${paid.length}</strong></div><div class="stat"><small>Ø¬Ø¯ÙŠØ¯Ø© Ù„Ù„ØªØ¬Ù‡ÙŠØ²</small><strong>${paid.filter(o => o.delivery_status === "NEW").length}</strong></div><div class="stat"><small>ØªØ­Øª Ø§Ù„ØªÙˆØµÙŠÙ„</small><strong>${paid.filter(o => ["PENDING","SENT_TO_ARMADA","ACCEPTED","DISPATCHED","EN_ROUTE"].includes(o.delivery_status)).length}</strong></div><div class="stat"><small>Ù…Ø¨ÙŠØ¹Ø§Øª Ø§Ù„ÙŠÙˆÙ…</small><strong>${money(sales)}</strong><small>ØºÙŠØ± Ù…ØªÙˆÙØ±: ${unavailable}</small></div>`;
}
function notifyNewPaid() {
  const paidIds = state.orders.filter(o => o.status === "PAID").map(o => o.id); const fresh = paidIds.filter(id => !state.seenPaid.has(id));
  if (state.notifications && Notification.permission === "granted") fresh.forEach(id => { const o = state.orders.find(x => x.id === id); new Notification("Ø·Ù„Ø¨ Ù…Ø¯ÙÙˆØ¹ Ø¬Ø¯ÙŠØ¯ - Aquafan", { body: `${o.id} Â· ${o.customer_name} Â· ${money(o.total)}` }); });
  paidIds.forEach(id => state.seenPaid.add(id)); localStorage.setItem("aquafanSeenPaid", JSON.stringify([...state.seenPaid].slice(-500)));
}
async function load() {
  try {
    setMessage("");
    const [orders, products, branches] = await Promise.all([api("/admin/api/orders"), api("/admin/api/products"), api("/admin/api/armada/branches")]);
    state.orders = (orders.orders || []).filter(order => order.status === "PAID"); state.products = products.products || []; state.branches = branches.branches || [];
    notifyNewPaid(); renderStats(); renderOrders(); renderProducts();
  } catch (e) { setMessage(e.message); }
}
document.addEventListener("click", async event => {
  const productId = event.target.dataset.saveProduct;
  if (productId) { try { const stock = Number(document.querySelector(`[data-stock="${productId}"]`).value); const price = Number(document.querySelector(`[data-price="${productId}"]`).value); const isAvailable = document.querySelector(`[data-available="${productId}"]`).value === "true"; await api(`/admin/api/products/${productId}`, { method:"PATCH", body:JSON.stringify({stock,price,isAvailable}) }); setMessage("ØªÙ… Ø­ÙØ¸ Ø§Ù„Ù…Ù†ØªØ¬."); await load(); } catch (e) { setMessage(e.message); } }
  const orderId = event.target.dataset.saveDelivery;
  if (orderId) { try { const status = document.querySelector(`[data-delivery-status="${CSS.escape(orderId)}"]`).value; const trackingUrl = document.querySelector(`[data-tracking="${CSS.escape(orderId)}"]`).value; await api(`/admin/api/orders/${encodeURIComponent(orderId)}/delivery`, { method:"PATCH", body:JSON.stringify({status,trackingUrl}) }); setMessage("ØªÙ… Ø­ÙØ¸ Ø­Ø§Ù„Ø© Ø§Ù„ØªÙˆØµÙŠÙ„."); await load(); } catch (e) { setMessage(e.message); } }
  const armadaOrderId = event.target.dataset.sendArmada;
  if (armadaOrderId) {
    const branchId = document.querySelector(`[data-armada-branch="${CSS.escape(armadaOrderId)}"]`).value;
    if (!branchId) return setMessage("Ø§Ø®ØªØ§Ø±ÙŠ ÙØ±Ø¹ Ø§Ù„Ø§Ø³ØªÙ„Ø§Ù… Ø£ÙˆÙ„Ù‹Ø§.");
    if (!confirm("Ø³ÙŠØªÙ… Ø¥Ø±Ø³Ø§Ù„ Ø§Ù„Ø·Ù„Ø¨ Ø§Ù„Ù…Ø¯ÙÙˆØ¹ Ø¥Ù„Ù‰ Armada Ø§Ù„Ø¢Ù†. Ù‡Ù„ ØªØ±ÙŠØ¯ÙŠÙ† Ø§Ù„Ù…ØªØ§Ø¨Ø¹Ø©ØŸ")) return;
    const button = event.target; const original = button.textContent; button.disabled = true; button.textContent = "Ø¬Ø§Ø±ÙŠ Ø§Ù„Ø¥Ø±Ø³Ø§Ù„â€¦";
    try { const result = await api(`/admin/api/orders/${encodeURIComponent(armadaOrderId)}/armada`, { method:"POST", body:JSON.stringify({branchId}) }); setMessage(`ØªÙ… Ø§Ù„Ø¥Ø±Ø³Ø§Ù„ Ø¥Ù„Ù‰ Armada Ø¨Ù†Ø¬Ø§Ø­. Ø±Ù‚Ù… Ø§Ù„ØªÙˆØµÙŠÙ„: ${result.code}`); await load(); } catch (e) { setMessage(e.message); button.disabled = false; button.textContent = original; }
  }
});
$("#refreshButton").addEventListener("click", load); $("#orderSearch").addEventListener("input", renderOrders); $("#productSearch").addEventListener("input", renderProducts);
$("#notifyButton").addEventListener("click", async () => { if (!("Notification" in window)) return setMessage("Ù‡Ø°Ø§ Ø§Ù„Ù…ØªØµÙØ­ Ù„Ø§ ÙŠØ¯Ø¹Ù… Ø§Ù„ØªÙ†Ø¨ÙŠÙ‡."); const permission = await Notification.requestPermission(); state.notifications = permission === "granted"; setMessage(state.notifications ? "ØªÙ… ØªÙØ¹ÙŠÙ„ Ø§Ù„ØªÙ†Ø¨ÙŠÙ‡ Ø£Ø«Ù†Ø§Ø¡ ÙØªØ­ Ø§Ù„ØªØ·Ø¨ÙŠÙ‚." : "Ù„Ù… ÙŠØªÙ… Ø§Ù„Ø³Ù…Ø§Ø­ Ø¨Ø§Ù„ØªÙ†Ø¨ÙŠÙ‡Ø§Øª."); });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/admin/service-worker.js");
load(); setInterval(load, 30000);
