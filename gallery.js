const STORAGE_PREFIX = "weekends-plans-v1:";
const galleryGrid = document.querySelector("#gallery-grid");
const galleryEmpty = document.querySelector("#gallery-empty");
const lightboxDialog = document.querySelector("#lightbox-dialog");
const lightboxImage = document.querySelector("#lightbox-image");
const objectUrls = new Set();
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function openPhotoDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("weekends-media-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("photos");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
  });
}

function getSavedPhotoReferences() {
  const references = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
    const saved = JSON.parse(localStorage.getItem(key) || "{}");
    if (!saved.plans || typeof saved.plans !== "object") continue;
    Object.entries(saved.plans).forEach(([day, meals]) => {
      if (!meals || typeof meals !== "object") return;
      Object.entries(meals).forEach(([meal, plan]) => {
        if (!plan?.photo?.key) return;
        references.push({
          day,
          meal,
          key: plan.photo.key,
          uploadedAt: Number(plan.photo.uploadedAt) || 0,
        });
      });
    });
  }
  return references;
}

function dateLabel(day) {
  const [year, month, date] = day.split("-").map(Number);
  const weekday = new Date(year, month - 1, date).getDay();
  return `${String(month).padStart(2, "0")}-${String(date).padStart(2, "0")}-${WEEKDAYS[weekday]}`;
}

function fallbackTimestamp(day) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date).getTime();
}

async function loadPhotos(references) {
  const db = await openPhotoDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("photos", "readonly");
    const store = transaction.objectStore("photos");
    const keysRequest = store.getAllKeys();
    const valuesRequest = store.getAll();
    transaction.oncomplete = () => {
      db.close();
      const photosByKey = new Map(keysRequest.result.map((key, index) => [key, valuesRequest.result[index]]));
      resolve(references
        .map((photo) => ({ ...photo, blob: photosByKey.get(photo.key) }))
        .filter((photo) => photo.blob instanceof Blob)
        .sort((a, b) => {
          const dateOrder = (b.uploadedAt || fallbackTimestamp(b.day)) - (a.uploadedAt || fallbackTimestamp(a.day));
          return dateOrder || b.day.localeCompare(a.day) || a.meal.localeCompare(b.meal);
        }));
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error || new Error("Photo library read failed"));
    };
  });
}

function showOriginalPhoto(blob, label) {
  if (lightboxImage.src) objectUrls.delete(lightboxImage.src);
  const url = URL.createObjectURL(blob);
  objectUrls.add(url);
  lightboxImage.src = url;
  lightboxImage.alt = `${label} 원본 사진`;
  lightboxDialog.showModal();
}

function renderPhotos(photos) {
  const cards = photos.map((photo) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "gallery-item";
    button.setAttribute("aria-label", `${dateLabel(photo.day)} 사진 원본 크게 보기`);
    const image = document.createElement("img");
    image.src = URL.createObjectURL(photo.blob);
    image.alt = "";
    objectUrls.add(image.src);
    image.loading = "lazy";
    image.addEventListener("error", () => {
      URL.revokeObjectURL(image.src);
      objectUrls.delete(image.src);
      button.remove();
      if (!galleryGrid.children.length) {
        galleryGrid.hidden = true;
        galleryEmpty.hidden = false;
        galleryEmpty.textContent = "사진을 불러오지 못했어요.";
        galleryEmpty.classList.add("gallery-error");
      }
    }, { once: true });
    const date = document.createElement("span");
    date.className = "gallery-date";
    date.textContent = dateLabel(photo.day);
    button.append(image, date);
    button.addEventListener("click", () => showOriginalPhoto(photo.blob, date.textContent));
    return button;
  });
  galleryGrid.replaceChildren(...cards);
  galleryGrid.hidden = photos.length === 0;
  galleryEmpty.hidden = photos.length > 0;
}

document.querySelector("#lightbox-close").addEventListener("click", () => lightboxDialog.close());
lightboxDialog.addEventListener("click", (event) => {
  if (event.target === lightboxDialog) lightboxDialog.close();
});
lightboxDialog.addEventListener("close", () => {
  if (lightboxImage.src) {
    URL.revokeObjectURL(lightboxImage.src);
    objectUrls.delete(lightboxImage.src);
    lightboxImage.removeAttribute("src");
  }
});
window.addEventListener("pagehide", () => {
  objectUrls.forEach((url) => URL.revokeObjectURL(url));
  objectUrls.clear();
});

async function initializeGallery() {
  try {
    const references = getSavedPhotoReferences();
    renderPhotos(await loadPhotos(references));
  } catch (error) {
    console.error("보석함 사진을 불러오지 못했습니다.", error);
    galleryEmpty.textContent = "사진을 불러오지 못했어요. 페이지를 새로고침해 주세요.";
    galleryEmpty.classList.add("gallery-error");
  }
}

initializeGallery();

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => console.error("오프라인 저장을 시작하지 못했습니다.", error));
  });
}
