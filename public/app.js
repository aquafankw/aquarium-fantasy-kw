const WHATSAPP_NUMBER = "96566221776";
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
  const active = select.value || "all";
  const items = [{value:"all",label:text("الكل", "All"),image:"assets/aquafan.jpg"}, ...categories.map(category => {
    const representative = state.products.find(product => product.category === category && product.image);
    return {value:category,label:category,image:representative?.image || "assets/aquafan.jpg"};
  })];
  $("#categoryRail").innerHTML = items.map(item => `<button type="button" class="category-circle${item.value === active ? " active" : ""}" data-category="${escapeHtml(item.value)}"><img src="${escapeHtml(item.image)}" alt="" loading="lazy" onerror="this.src='assets/aquafan.jpg'"><b>${escapeHtml(item.label)}</b></button>`).join("");
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
  $("#productGrid").innerHTML = state.filtered.length ? state.filtered.map(product => {
    const images = productImages(product);
    const gallery = images.length > 1;
    return `
    <article class="product-card">
      <div class="product-gallery" data-gallery="${product.id}">
        <div class="product-image"><img src="${escapeHtml(images[0] || "")}" alt="${escapeHtml(state.lang === "ar" ? product.nameAr : product.nameEn)}" loading="lazy" onerror="this.closest('.product-image').classList.add('image-error');this.style.display='none'">${gallery ? `<button class="gallery-arrow gallery-prev" data-gallery-prev="${product.id}" aria-label="${text("الصورة السابقة", "Previous image")}">‹</button><button class="gallery-arrow gallery-next" data-gallery-next="${product.id}" aria-label="${text("الصورة التالية", "Next image")}">›</button>` : ""}<span class="stock-tag">${product.stock > 0 ? text("متوفر", "In stock") : text("غير متوفر", "Out of stock")}</span></div>
        ${gallery ? `<div class="gallery-thumbs">${images.map((image,index) => `<button class="gallery-thumb${index === 0 ? " active" : ""}" data-gallery-thumb="${product.id}" data-image-index="${index}" aria-label="${text(`عرض الصورة ${index + 1}`, `View image ${index + 1}`)}"><img src="${escapeHtml(image)}" alt="" loading="lazy"></button>`).join("")}</div>` : ""}
      </div>
      <div class="product-body"><span class="category-label">${escapeHtml(product.category)} · #${product.id}</span><h3>${escapeHtml(state.lang === "ar" ? product.nameAr : product.nameEn)}</h3><p class="product-secondary">${escapeHtml(state.lang === "ar" ? product.nameEn : product.nameAr)}</p><div class="product-bottom"><span class="price">${money(product.price)}</span><button class="add-button" data-add="${product.id}" ${product.stock <= 0 ? "disabled" : ""}>${text("أضف للسلة", "Add to cart")}</button></div></div>
    </article>`;
  }).join("") : `<div class="empty">${text("لم نجد منتجات مطابقة لبحثك.", "No products match your search.")}</div>`;
}

function productImages(product) { const images = Array.isArray(product.images) ? product.images : []; return [...new Set([product.image, ...images].filter(Boolean))]; }
function showGalleryImage(productId, requestedIndex) { const product=state.products.find(item=>item.id===Number(productId));const gallery=document.querySelector(`[data-gallery="${productId}"]`);if(!product||!gallery)return;const images=productImages(product);if(!images.length)return;const index=((requestedIndex||0)+images.length)%images.length;gallery.dataset.imageIndex=index;const mainImage=gallery.querySelector(".product-image > img");mainImage.style.display="";mainImage.src=images[index];gallery.querySelector(".product-image").classList.remove("image-error");gallery.querySelectorAll(".gallery-thumb").forEach((thumb,i)=>thumb.classList.toggle("active",i===index)); }

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

async function checkout() {
  const entries = Object.entries(state.cart); if (!entries.length) return showToast(text("أضيفي منتجاً أولاً", "Add a product first"));
  const customer = {
    name: $("#customerName").value.trim(), phone: $("#customerPhone").value.trim(), email: $("#customerEmail").value.trim(),
    governorate: $("#customerGovernorate").value.trim(), area: $("#customerArea").value.trim(), block: $("#customerBlock").value.trim(),
    street: $("#customerStreet").value.trim(), avenue: $("#customerAvenue").value.trim(), building: $("#customerBuilding").value.trim(),
    floor: $("#customerFloor").value.trim(), apartment: $("#customerApartment").value.trim(), notes: $("#customerAddressNotes").value.trim()
  };
  if (!customer.name || !customer.phone || !customer.governorate || !customer.area || !customer.block || !customer.street || !customer.building) return showToast(text("أكملي الاسم والهاتف والمحافظة والمنطقة والقطعة والشارع والمنزل أو المبنى", "Complete the required customer and address fields"));
  const button = $("#checkout"); const original = button.textContent; button.disabled = true; button.textContent = text("جاري فتح الدفع…", "Opening payment…");
  try {
    const response = await fetch("/api/create-payment", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customer, items: entries.map(([id,quantity]) => ({ id: Number(id), quantity: Number(quantity) })) }) });
    const result = await response.json();
    if (!response.ok || !result.invoiceURL) throw new Error(result.error || text("تعذّر إنشاء رابط الدفع", "Could not create payment link"));
    sessionStorage.setItem("aquafan-last-order", result.orderId || "");
    window.location.href = result.invoiceURL;
  } catch (error) {
    showToast(error.message || text("تعذّر الاتصال بالدفع", "Payment connection failed"));
    button.disabled = false; button.textContent = original;
  }
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
  $("#categoryPrev").addEventListener("click",()=>$("#categoryRail").scrollBy({left:-280,behavior:"smooth"})); $("#categoryNext").addEventListener("click",()=>$("#categoryRail").scrollBy({left:280,behavior:"smooth"}));
  const rail=$("#categoryRail");
  let dragging=false,startX=0,startScroll=0,moved=false,ignoreNextClick=false;
  rail.addEventListener("pointerdown",e=>{dragging=true;moved=false;startX=e.clientX;startScroll=rail.scrollLeft;rail.classList.add("dragging")});
  rail.addEventListener("pointermove",e=>{if(!dragging)return;const delta=e.clientX-startX;if(Math.abs(delta)>12)moved=true;rail.scrollLeft=startScroll-delta});
  const finishCategoryDrag=()=>{ignoreNextClick=moved;dragging=false;rail.classList.remove("dragging");setTimeout(()=>{ignoreNextClick=false},0)};
  rail.addEventListener("pointerup",finishCategoryDrag); rail.addEventListener("pointercancel",finishCategoryDrag);
  rail.addEventListener("click",e=>{const button=e.target.closest("[data-category]");if(!button||ignoreNextClick)return;$("#category").value=button.dataset.category;rail.querySelectorAll(".category-circle").forEach(item=>item.classList.toggle("active",item===button));filterProducts();});
  $("#language").addEventListener("click",()=>{state.lang=state.lang==="ar"?"en":"ar";updateLanguage()}); $("#openCart").addEventListener("click",()=>openCart(true)); $("#closeCart").addEventListener("click",()=>openCart(false)); $("#scrim").addEventListener("click",()=>openCart(false)); $("#checkout").addEventListener("click",checkout);
  document.addEventListener("click",e=>{const add=e.target.closest("[data-add]");if(add)addToCart(Number(add.dataset.add));const qty=e.target.closest("[data-qty]");if(qty)changeQuantity(qty.dataset.qty,Number(qty.dataset.delta));const remove=e.target.closest("[data-remove]");if(remove){delete state.cart[remove.dataset.remove];saveCart();}const previous=e.target.closest("[data-gallery-prev]");if(previous){const gallery=previous.closest("[data-gallery]");showGalleryImage(previous.dataset.galleryPrev,Number(gallery.dataset.imageIndex||0)-1);}const next=e.target.closest("[data-gallery-next]");if(next){const gallery=next.closest("[data-gallery]");showGalleryImage(next.dataset.galleryNext,Number(gallery.dataset.imageIndex||0)+1);}const thumb=e.target.closest("[data-gallery-thumb]");if(thumb)showGalleryImage(thumb.dataset.galleryThumb,Number(thumb.dataset.imageIndex));});
  document.addEventListener("keydown",e=>{if(e.key==="Escape")openCart(false)});
}
init();
