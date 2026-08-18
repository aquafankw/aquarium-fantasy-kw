const WHATSAPP_NUMBER = "96566221776"; // Replace with the shop's real number before publishing.
const state = { products: [], filtered: [], cart: JSON.parse(localStorage.getItem("aquafan-cart") || "{}"), lang: "ar" };
const $ = (selector) => document.querySelector(selector);
const money = (value) => `${Number(value).toFixed(3)} ${state.lang === "ar" ? "د.ك" : "KWD"}`;
const text = (ar, en) => state.lang === "ar" ? ar : en;

async function init() {
  try {
    const response = await fetch("products.json");
    if (!response.ok) throw new Error("Products unavailable");
    state.products = await response.json();
    populateCategories();
    filterProducts();
  } catch (error) {
    $("#productGrid").innerHTML = `<div class="empty">${text("تعذّر تحميل المنتجات. افتحي الموقع من رابط النشر بعد رفعه إلى GitHub.", "Products could not load. Open the deployed website after uploading it to GitHub.")}</div>`;
  }
  bindEvents(); updateCart(); updateLanguage(); $("#year").textContent = new Date().getFullYear();
  const wa = `https://wa.me/${WHATSAPP_NUMBER}`;
  $("#heroWhatsApp").href = wa;
}

function populateCategories() {
  const categories = [...new Set(state.products.map(p => p.category).filter(Boolean))].sort();
  const select = $("#category");
  select.innerHTML = `<option value="all">${text("كل التصنيفات", "All categories")}</option>` + categories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
}

function filterProducts() {
  const query = $("#search").value.trim().toLowerCase();
  const category = $("#category").value;
  const sort = $("#sort").value;
  state.filtered = state.products.filter(p => (category === "all" || p.category === category) && `${p.id} ${p.nameAr} ${p.nameEn}`.toLowerCase().includes(query));
  if (sort === "low") state.filtered.sort((a,b) => a.price - b.price);
  if (sort === "high") state.filtered.sort((a,b) => b.price - a.price);
  renderProducts();
}

function renderProducts() {
  $("#productCount").textContent = text(`${state.filtered.length} منتج`, `${state.filtered.length} products`);
  $("#productGrid").innerHTML = state.filtered.length ? state.filtered.map(product => `
    <article class="product-card">
      <div class="product-image"><span class="image-fallback">🐠</span><img src="${product.image}" alt="${escapeHtml(state.lang === "ar" ? product.nameAr : product.nameEn)}" loading="lazy" onerror="this.style.display='none'"><span class="stock-tag">${product.stock > 0 ? text("متوفر", "In stock") : text("غير متوفر", "Out of stock")}</span></div>
      <div class="product-body"><span class="category-label">${escapeHtml(product.category)} · #${product.id}</span><h3>${escapeHtml(state.lang === "ar" ? product.nameAr : product.nameEn)}</h3><p class="product-secondary">${escapeHtml(state.lang === "ar" ? product.nameEn : product.nameAr)}</p><div class="product-bottom"><span class="price">${money(product.price)}</span><button class="add-button" data-add="${product.id}" ${product.stock <= 0 ? "disabled" : ""}>${text("أضف للسلة", "Add to cart")}</button></div></div>
    </article>`).join("") : `<div class="empty">${text("لم نجد منتجات مطابقة لبحثك.", "No products match your search.")}</div>`;
}

function addToCart(id) { state.cart[id] = (state.cart[id] || 0) + 1; saveCart(); showToast(text("تمت إضافة المنتج للسلة", "Added to cart")); }
function changeQuantity(id, delta) { state.cart[id] = (state.cart[id] || 0) + delta; if (state.cart[id] <= 0) delete state.cart[id]; saveCart(); }
function saveCart() { localStorage.setItem("aquafan-cart", JSON.stringify(state.cart)); updateCart(); }
function updateCart() {
  const entries = Object.entries(state.cart);
  $("#cartCount").textContent = entries.reduce((sum,[,qty]) => sum + qty, 0);
  let total = 0;
  $("#cartItems").innerHTML = entries.length ? entries.map(([id,qty]) => {
    const product = state.products.find(p => p.id === Number(id)); if (!product) return "";
    total += product.price * qty;
    return `<div class="cart-item"><b>${escapeHtml(state.lang === "ar" ? product.nameAr : product.nameEn)}</b><span>${money(product.price * qty)}</span><div class="cart-controls"><button data-qty="${id}" data-delta="-1">−</button><span>${qty}</span><button data-qty="${id}" data-delta="1">+</button><button class="remove" data-remove="${id}">${text("حذف", "Remove")}</button></div></div>`;
  }).join("") : `<div class="cart-empty">🛒<br>${text("سلتك فارغة حالياً", "Your cart is empty")}</div>`;
  $("#cartTotal").textContent = money(total);
}

function checkout() {
  const entries = Object.entries(state.cart); if (!entries.length) return showToast(text("أضيفي منتجاً أولاً", "Add a product first"));
  const lines = entries.map(([id,qty]) => { const p=state.products.find(x=>x.id===Number(id)); return `• ${p.nameAr} (#${p.id}) × ${qty} = ${money(p.price*qty)}`; });
  const total = entries.reduce((sum,[id,qty]) => { const p=state.products.find(x=>x.id===Number(id)); return sum+p.price*qty; },0);
  const message = `مرحباً Aquafan، أود طلب:\n${lines.join("\n")}\n\nالإجمالي: ${money(total)}`;
  window.open(`https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`, "_blank", "noopener");
}

function updateLanguage() {
  document.documentElement.lang = state.lang; document.documentElement.dir = state.lang === "ar" ? "rtl" : "ltr";
  document.querySelectorAll("[data-ar]").forEach(el => el.textContent = el.dataset[state.lang]);
  document.querySelectorAll("[data-placeholder-ar]").forEach(el => el.placeholder = el.dataset[`placeholder${state.lang === "ar" ? "Ar" : "En"}`]);
  $("#language").textContent = state.lang === "ar" ? "English" : "العربية";
  $("#sort").options[0].text = text("الموصى بها", "Recommended"); $("#sort").options[1].text = text("السعر: الأقل أولاً", "Price: low to high"); $("#sort").options[2].text = text("السعر: الأعلى أولاً", "Price: high to low");
  if (state.products.length) { populateCategories(); filterProducts(); updateCart(); }
}

function openCart(open) { $("#cartPanel").classList.toggle("open",open); $("#cartPanel").setAttribute("aria-hidden",String(!open)); $("#scrim").hidden=!open; document.body.style.overflow=open?"hidden":""; }
function showToast(message) { const toast=$("#toast"); toast.textContent=message; toast.classList.add("show"); clearTimeout(showToast.timer); showToast.timer=setTimeout(()=>toast.classList.remove("show"),1800); }
function escapeHtml(value="") { return String(value).replace(/[&<>'"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char])); }
function bindEvents() {
  $("#search").addEventListener("input",filterProducts); $("#category").addEventListener("change",filterProducts); $("#sort").addEventListener("change",filterProducts);
  $("#language").addEventListener("click",()=>{state.lang=state.lang==="ar"?"en":"ar";updateLanguage()}); $("#openCart").addEventListener("click",()=>openCart(true)); $("#closeCart").addEventListener("click",()=>openCart(false)); $("#scrim").addEventListener("click",()=>openCart(false)); $("#checkout").addEventListener("click",checkout);
  document.addEventListener("click",e=>{const add=e.target.closest("[data-add]");if(add)addToCart(Number(add.dataset.add));const qty=e.target.closest("[data-qty]");if(qty)changeQuantity(qty.dataset.qty,Number(qty.dataset.delta));const remove=e.target.closest("[data-remove]");if(remove){delete state.cart[remove.dataset.remove];saveCart();}});
  document.addEventListener("keydown",e=>{if(e.key==="Escape")openCart(false)});
}
init();
