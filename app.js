const MEALS = [
  { id: "morning", name: "아침", time: "09 — 12" },
  { id: "lunch", name: "점심", time: "12 — 18" },
  { id: "evening", name: "저녁", time: "18 — 21" },
];
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const STORE_PREFIX = "weekends-plans-v1";

const daysTrack = document.querySelector("#days-track");
const weekTitle = document.querySelector("#week-title");
const authPanel = document.querySelector("#auth-panel");
const loadingPanel = document.querySelector("#loading-panel");
const plannerContent = document.querySelector("#planner-content");
const authForm = document.querySelector("#auth-form");
const authEmail = document.querySelector("#auth-email");
const authPassword = document.querySelector("#auth-password");
const authSubmit = document.querySelector("#auth-submit");
const authModeToggle = document.querySelector("#auth-mode-toggle");
const authMessage = document.querySelector("#auth-message");
const accountEmail = document.querySelector("#account-email");
const signOutButton = document.querySelector("#sign-out-button");
const saveLabel = document.querySelector(".save-label");
const dayDialog = document.querySelector("#day-dialog");
const dayForm = document.querySelector("#day-form");
const calendarDialog = document.querySelector("#calendar-dialog");
const calendarGrid = document.querySelector("#calendar-grid");
const calendarMonth = document.querySelector("#calendar-month");
const photoDialog = document.querySelector("#photo-dialog");
const photoForm = document.querySelector("#photo-form");
const photoFile = document.querySelector("#photo-file");
const cropStage = document.querySelector("#crop-stage");
const cropImage = document.querySelector("#crop-image");
const photoZoom = document.querySelector("#photo-zoom");
const saveState = document.querySelector("#save-state");
const toast = document.querySelector("#toast");

const state = { weekStart: getMonday(new Date()), days: [], plans: {}, notes: {}, user: null };
const config = window.WEEKENDS_SUPABASE_CONFIG;
let supabaseClient = null;
let isSignUpMode = false;
let weekLoadRequest = 0;
const migratedUsers = new Set();
let photoTarget = null;
let cropPointer = null;
let cropObjectUrl = null;
let toastTimer;
let saveTimer;
let calendarDate = new Date(state.weekStart.getFullYear(), state.weekStart.getMonth(), 1);

function getMonday(date) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = result.getDay();
  result.setDate(result.getDate() + (day === 0 ? -6 : 1 - day));
  result.setHours(0, 0, 0, 0);
  return result;
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDate(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function weekNumber(date) {
  const value = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  value.setUTCDate(value.getUTCDate() + 4 - (value.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  return Math.ceil(((value - yearStart) / 86400000 + 1) / 7);
}

function weekYear(date) {
  const thursday = new Date(date);
  thursday.setDate(thursday.getDate() + 3);
  return thursday.getFullYear();
}

function weekDates() {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(state.weekStart);
    date.setDate(date.getDate() + index);
    return date;
  });
}

function storageKey() {
  return `${STORE_PREFIX}:${dateKey(state.weekStart)}`;
}

function setWeekData(saved) {
  const baseWeekend = weekDates().filter((date) => date.getDay() === 0 || date.getDay() === 6)
    .map((date) => ({ date: dateKey(date), kind: "weekend", name: "" }));
  const savedDays = saved && Array.isArray(saved.days) ? saved.days : [];
  state.days = [...baseWeekend];
  savedDays.forEach((day) => {
    if (day && weekDates().some((date) => dateKey(date) === day.date) && !state.days.some((entry) => entry.date === day.date)) {
      state.days.push(day);
    }
  });
  state.plans = saved && saved.plans && typeof saved.plans === "object" ? saved.plans : {};
  state.notes = saved && saved.notes && typeof saved.notes === "object" ? saved.notes : {};
}

function loadLocalWeek() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey()) || "{}");
    setWeekData(saved);
  } catch (error) {
    console.error("주간 계획을 불러오지 못했습니다.", error);
    setWeekData(null);
    showToast("저장된 계획을 읽지 못했어요.");
  }
  render();
}

function loadWeek() {
  if (!state.user || !supabaseClient) return;
  const weekStart = dateKey(state.weekStart);
  void loadCloudWeek(state.user, weekStart);
}

async function migrateLocalWeeks(user) {
  if (migratedUsers.has(user.id)) return;
  const rows = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key || !key.startsWith(`${STORE_PREFIX}:`)) continue;
    const weekStart = key.slice(STORE_PREFIX.length + 1);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) continue;
    try {
      const data = JSON.parse(localStorage.getItem(key) || "{}");
      rows.push({ user_id: user.id, week_start: weekStart, data });
    } catch (error) {
      console.error(`저장된 ${weekStart} 주간 계획을 이전하지 못했습니다.`, error);
      showToast("일부 기기 저장 데이터를 읽지 못해 이전하지 못했어요.");
    }
  }
  if (rows.length) {
    const { error } = await supabaseClient
      .from("week_plans")
      .upsert(rows, { onConflict: "user_id,week_start", ignoreDuplicates: true });
    if (error) throw error;
  }
  migratedUsers.add(user.id);
}

async function loadCloudWeek(user, weekStart) {
  const requestId = ++weekLoadRequest;
  daysTrack.inert = true;
  daysTrack.setAttribute("aria-busy", "true");
  saveLabel.textContent = "클라우드에서 불러오는 중";
  try {
    try {
      await migrateLocalWeeks(user);
    } catch (error) {
      console.error("기기에 저장된 계획을 클라우드로 이전하지 못했습니다.", error);
      showToast("기기 계획 일부를 이전하지 못했어요. 기존 클라우드 계획은 유지됩니다.");
    }
    const { data, error } = await supabaseClient
      .from("week_plans")
      .select("data")
      .eq("user_id", user.id)
      .eq("week_start", weekStart)
      .maybeSingle();
    if (error) throw error;
    if (requestId !== weekLoadRequest || state.user?.id !== user.id || dateKey(state.weekStart) !== weekStart) return;
    setWeekData(data?.data || null);
    render();
    daysTrack.inert = false;
    daysTrack.setAttribute("aria-busy", "false");
    saveLabel.textContent = "계정과 동기화돼요";
  } catch (error) {
    console.error("클라우드 주간 계획을 불러오지 못했습니다.", error);
    if (requestId !== weekLoadRequest || state.user?.id !== user.id) return;
    setWeekData(null);
    render();
    daysTrack.inert = false;
    daysTrack.setAttribute("aria-busy", "false");
    saveLabel.textContent = "동기화 오류";
    showToast("계획을 불러오지 못했어요. 연결과 Supabase 정책을 확인해 주세요.");
  }
}

function saveWeek() {
  const key = storageKey();
  const weekStart = dateKey(state.weekStart);
  const user = state.user;
  const snapshot = JSON.stringify({ days: state.days, plans: state.plans, notes: state.notes });
  saveState.classList.add("saving");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(key, snapshot);
    } catch (error) {
      console.error("주간 계획을 저장하지 못했습니다.", error);
      showToast("저장 공간이 부족해요. 사진을 줄이거나 삭제해 주세요.");
    }
    if (!user || !supabaseClient) {
      saveState.classList.remove("saving");
      return;
    }
    saveLabel.textContent = "동기화 중";
    supabaseClient.from("week_plans").upsert({
      user_id: user.id,
      week_start: weekStart,
      data: JSON.parse(snapshot),
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,week_start" }).then(({ error }) => {
      if (state.user?.id !== user.id) return;
      saveState.classList.remove("saving");
      if (error) {
        console.error("클라우드에 주간 계획을 저장하지 못했습니다.", error);
        saveLabel.textContent = "동기화 오류";
        showToast("클라우드 저장에 실패했어요. 인터넷 연결을 확인해 주세요.");
        return;
      }
      saveLabel.textContent = "계정과 동기화돼요";
    }).catch((error) => {
      console.error("클라우드에 주간 계획을 저장하지 못했습니다.", error);
      if (state.user?.id === user.id) {
        saveState.classList.remove("saving");
        saveLabel.textContent = "동기화 오류";
        showToast("클라우드 저장에 실패했어요. 인터넷 연결을 확인해 주세요.");
      }
    });
  }, 180);
}

function formatRange(start) {
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return `${start.getMonth() + 1}/${start.getDate()}–${end.getMonth() + 1}/${end.getDate()}`;
}

function render() {
  weekTitle.innerHTML = `W${weekNumber(state.weekStart)} <span>(${formatRange(state.weekStart)})</span>`;
  state.days.sort((a, b) => a.date.localeCompare(b.date));
  daysTrack.replaceChildren(...state.days.map(renderDay));
}

function renderCalendar() {
  const year = calendarDate.getFullYear();
  const month = calendarDate.getMonth();
  const monthValue = `${year}-${String(month + 1).padStart(2, "0")}`;
  calendarMonth.value = monthValue;
  document.querySelector("#calendar-month-label").textContent = `${year}년 ${month + 1}월`;

  const headings = document.createElement("div");
  headings.className = "calendar-weekday";
  ["주차", "월", "화", "수", "목", "금", "토", "일"].forEach((heading) => {
    const cell = document.createElement("span");
    cell.textContent = heading;
    headings.append(cell);
  });
  const rows = [headings];
  const firstOfMonth = new Date(year, month, 1);
  const firstMonday = getMonday(firstOfMonth);
  const lastOfMonth = new Date(year, month + 1, 0);

  for (let monday = new Date(firstMonday); monday <= lastOfMonth; monday.setDate(monday.getDate() + 7)) {
    const weekStart = new Date(monday);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "calendar-week";
    const isCurrentWeek = dateKey(weekStart) === dateKey(state.weekStart);
    if (isCurrentWeek) row.classList.add("current-week");
    row.setAttribute("aria-pressed", String(isCurrentWeek));
    row.setAttribute("aria-label", `${weekYear(weekStart)}년 ${weekNumber(weekStart)}주, ${formatRange(weekStart)} 선택`);
    row.addEventListener("click", () => selectWeek(weekStart));

    const weekNumberCell = document.createElement("span");
    weekNumberCell.className = "calendar-week-number";
    weekNumberCell.textContent = `W${weekNumber(weekStart)}`;
    row.append(weekNumberCell);

    for (let index = 0; index < 7; index += 1) {
      const date = new Date(weekStart);
      date.setDate(date.getDate() + index);
      const dayCell = document.createElement("span");
      dayCell.className = "calendar-day";
      dayCell.textContent = String(date.getDate());
      if (date.getMonth() !== month) dayCell.classList.add("outside-month");
      if (dateKey(date) === dateKey(state.weekStart)) dayCell.classList.add("week-start");
      row.append(dayCell);
    }
    rows.push(row);
  }
  calendarGrid.replaceChildren(...rows);
}

function selectWeek(start) {
  state.weekStart = new Date(start);
  loadWeek();
  calendarDialog.close();
}

function openCalendarDialog() {
  calendarDate = new Date(state.weekStart.getFullYear(), state.weekStart.getMonth(), 1);
  renderCalendar();
  calendarDialog.showModal();
}

function changeCalendarMonth(amount) {
  calendarDate = new Date(calendarDate.getFullYear(), calendarDate.getMonth() + amount, 1);
  renderCalendar();
}

function renderDay(day) {
  const date = parseDate(day.date);
  const dayOfWeek = date.getDay();
  const card = document.createElement("article");
  card.className = `day-card ${day.kind === "weekend" && dayOfWeek === 6 ? "weekend-saturday" : ""} ${day.kind === "weekend" && dayOfWeek === 0 ? "weekend-sunday" : ""}`;

  const header = document.createElement("header");
  header.className = "day-header";
  const left = document.createElement("div");
  left.className = "day-header-left";
  const number = document.createElement("span");
  number.className = "date-number";
  number.textContent = date.getDate();
  const titleWrap = document.createElement("div");
  const title = document.createElement("p");
  title.className = "day-title";
  title.textContent = `${WEEKDAYS[dayOfWeek]}요일`;
  const subtitle = document.createElement("p");
  subtitle.className = "day-subtitle";
  subtitle.textContent = `${date.getMonth() + 1}월 ${date.getDate()}일`;
  titleWrap.append(title, subtitle);
  left.append(number, titleWrap);
  header.append(left);

  if (day.kind !== "weekend") {
    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.alignItems = "center";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-day";
    remove.setAttribute("aria-label", `${subtitle.textContent} 날짜 삭제`);
    remove.textContent = "×";
    remove.addEventListener("click", () => removeDay(day.date));
    right.append(remove);
    header.append(right);
  }

  const mealGrid = document.createElement("div");
  mealGrid.className = "meal-grid";
  MEALS.forEach((meal) => mealGrid.append(renderMeal(day.date, meal)));
  card.append(header, mealGrid, renderDayNote(day.date));
  return card;
}

function renderDayNote(day) {
  const area = document.createElement("div");
  area.className = "day-note-area";
  if (Object.prototype.hasOwnProperty.call(state.notes, day)) {
    const label = document.createElement("label");
    label.className = "day-note-label";
    label.textContent = "메모";
    const textarea = document.createElement("textarea");
    textarea.className = "day-note-input";
    textarea.setAttribute("aria-label", `${day} 메모`);
    textarea.maxLength = 500;
    textarea.value = state.notes[day];
    textarea.addEventListener("input", () => {
      state.notes[day] = textarea.value;
      saveWeek();
    });
    area.append(label, textarea);
  } else {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "add-note-button";
    button.textContent = "＋ 메모 추가";
    button.setAttribute("aria-label", `${day} 메모 추가`);
    button.addEventListener("click", () => {
      state.notes[day] = "";
      saveWeek();
      render();
      daysTrack.querySelector(`[aria-label="${day} 메모"]`)?.focus();
    });
    area.append(button);
  }
  return area;
}

function planFor(day, mealId) {
  if (!state.plans[day]) state.plans[day] = {};
  if (!state.plans[day][mealId]) state.plans[day][mealId] = { text: "", photo: null };
  return state.plans[day][mealId];
}

function renderMeal(day, meal) {
  const plan = planFor(day, meal.id);
  const card = document.createElement("section");
  card.className = `meal-card ${meal.id}`;
  card.setAttribute("aria-label", `${day} ${meal.name} 계획`);
  const heading = document.createElement("div");
  heading.className = "meal-heading";
  const name = document.createElement("span");
  name.className = "meal-name";
  name.textContent = meal.name;
  const time = document.createElement("span");
  time.className = "meal-time";
  time.textContent = meal.time;
  heading.append(name, time);

  const textarea = document.createElement("textarea");
  textarea.className = "plan-input";
  textarea.setAttribute("aria-label", `${day} ${meal.name} 계획 입력`);
  textarea.maxLength = 500;
  textarea.value = plan.text || "";
  fitText(textarea);
  textarea.addEventListener("input", () => {
    plan.text = textarea.value;
    fitText(textarea);
    saveWeek();
  });

  const actions = document.createElement("div");
  actions.className = "meal-actions";
  const photoButton = document.createElement("button");
  photoButton.type = "button";
  photoButton.className = "photo-button";
  photoButton.innerHTML = `<span aria-hidden="true">▧</span><span>${plan.photo ? "사진 변경" : "사진 추가"}</span>`;
  photoButton.addEventListener("click", () => choosePhoto(day, meal.id));
  actions.append(photoButton);
  if (plan.photo) {
    card.classList.add("has-photo");
    const removePhoto = document.createElement("button");
    removePhoto.type = "button";
    removePhoto.className = "photo-button remove-photo";
    removePhoto.setAttribute("aria-label", "사진 삭제");
    removePhoto.textContent = "×";
    removePhoto.addEventListener("click", () => clearPhoto(day, meal.id));
    actions.append(removePhoto);
    loadPhoto(plan.photo.key).then((blob) => {
      if (!blob || !card.isConnected) return;
      const image = document.createElement("img");
      image.className = "meal-photo";
      image.alt = "";
      image.src = URL.createObjectURL(blob);
      image.style.objectPosition = `${plan.photo.x}% ${plan.photo.y}%`;
      image.style.setProperty("--photo-zoom", plan.photo.zoom);
      image.addEventListener("load", () => URL.revokeObjectURL(image.src), { once: true });
      card.prepend(image);
    }).catch((error) => {
      console.error("사진을 불러오지 못했습니다.", error);
      showToast("저장된 사진을 불러오지 못했어요.");
    });
  }
  card.append(heading, textarea, actions);
  return card;
}

function fitText(textarea) {
  const length = textarea.value.length;
  const fontSize = Math.max(10, Math.min(20, 20 - Math.max(0, length - 10) * 0.075));
  textarea.style.fontSize = `${fontSize}px`;
}

function changeWeek(amount) {
  state.weekStart.setDate(state.weekStart.getDate() + amount * 7);
  loadWeek();
}

function removeDay(day) {
  state.days = state.days.filter((entry) => entry.date !== day);
  const plans = state.plans[day];
  delete state.plans[day];
  delete state.notes[day];
  saveWeek();
  render();
  if (plans) {
    Promise.all(Object.values(plans).filter((plan) => plan.photo).map((plan) => deletePhoto(plan.photo.key)))
      .catch((error) => {
        console.error("날짜의 사진을 삭제하지 못했습니다.", error);
        showToast("일정은 삭제했지만 사진 일부를 정리하지 못했어요.");
      });
  }
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2800);
}

function updateAuthMode() {
  authSubmit.textContent = isSignUpMode ? "회원가입" : "로그인";
  authModeToggle.textContent = isSignUpMode
    ? "이미 계정이 있나요? 로그인"
    : "처음 오셨나요? 회원가입";
  authPassword.autocomplete = isSignUpMode ? "new-password" : "current-password";
  authMessage.textContent = "";
}

async function setActiveSession(session) {
  const user = session?.user || null;
  state.user = user;
  if (!user) {
    weekLoadRequest += 1;
    authPanel.hidden = false;
    loadingPanel.hidden = true;
    plannerContent.hidden = true;
    accountEmail.hidden = true;
    signOutButton.hidden = true;
    saveLabel.textContent = "로그인해 주세요";
    return;
  }
  authPanel.hidden = true;
  loadingPanel.hidden = false;
  plannerContent.hidden = true;
  accountEmail.textContent = user.email || "";
  accountEmail.hidden = !user.email;
  signOutButton.hidden = false;
  await loadCloudWeek(user, dateKey(state.weekStart));
  if (state.user?.id === user.id) {
    loadingPanel.hidden = true;
    plannerContent.hidden = false;
  }
}

async function initializeSupabase() {
  if (!config || !config.url || !config.publishableKey
    || config.url.includes("YOUR_") || config.publishableKey.includes("YOUR_")
    || !window.supabase?.createClient) {
    authPanel.hidden = false;
    loadingPanel.hidden = true;
    plannerContent.hidden = true;
    saveLabel.textContent = "연결 설정 필요";
    authMessage.textContent = "Supabase 연결 설정을 확인해 주세요.";
    return;
  }

  try {
    supabaseClient = window.supabase.createClient(config.url, config.publishableKey);
    const { data, error } = await supabaseClient.auth.getSession();
    if (error) throw error;
    await setActiveSession(data.session);
    supabaseClient.auth.onAuthStateChange((_event, session) => {
      queueMicrotask(() => {
        setActiveSession(session).catch((error) => {
          console.error("로그인 상태를 적용하지 못했습니다.", error);
          authMessage.textContent = "로그인 상태를 확인하지 못했어요. 페이지를 새로고침해 주세요.";
        });
      });
    });
  } catch (error) {
    console.error("Supabase에 연결하지 못했습니다.", error);
    authPanel.hidden = false;
    loadingPanel.hidden = true;
    plannerContent.hidden = true;
    saveLabel.textContent = "연결 오류";
    authMessage.textContent = "Supabase에 연결하지 못했어요. Project URL과 공개 키를 확인해 주세요.";
  }
}

authModeToggle.addEventListener("click", () => {
  isSignUpMode = !isSignUpMode;
  updateAuthMode();
});

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!supabaseClient) {
    authMessage.textContent = "Supabase 연결을 먼저 확인해 주세요.";
    return;
  }
  authSubmit.disabled = true;
  authMessage.textContent = isSignUpMode ? "회원가입 중..." : "로그인 중...";
  try {
    const email = authEmail.value.trim();
    const password = authPassword.value;
    const result = isSignUpMode
      ? await supabaseClient.auth.signUp({ email, password })
      : await supabaseClient.auth.signInWithPassword({ email, password });
    if (result.error) throw result.error;
    if (isSignUpMode && !result.data.session) {
      authMessage.textContent = "가입 확인 메일을 보냈어요. 메일의 링크를 눌러 가입을 완료해 주세요.";
      return;
    }
    authMessage.textContent = "";
    await setActiveSession(result.data.session);
  } catch (error) {
    console.error(isSignUpMode ? "회원가입에 실패했습니다." : "로그인에 실패했습니다.", error);
    authMessage.textContent = error.message || "요청을 완료하지 못했어요. 입력한 정보를 확인해 주세요.";
  } finally {
    authSubmit.disabled = false;
  }
});

signOutButton.addEventListener("click", async () => {
  signOutButton.disabled = true;
  try {
    const { error } = await supabaseClient.auth.signOut();
    if (error) throw error;
    await setActiveSession(null);
  } catch (error) {
    console.error("로그아웃하지 못했습니다.", error);
    showToast("로그아웃하지 못했어요. 다시 시도해 주세요.");
  } finally {
    signOutButton.disabled = false;
  }
});

function openDayDialog() {
  const dates = weekDates();
  const firstDay = dateKey(dates[0]);
  const lastDay = dateKey(dates[6]);
  const dateInput = dayForm.elements.date;
  dateInput.min = firstDay;
  dateInput.max = lastDay;
  const available = dates.find((date) => !state.days.some((day) => day.date === dateKey(date)));
  dateInput.value = available ? dateKey(available) : "";
  dateInput.disabled = !available;
  dayForm.querySelector(".primary-button").disabled = !available;
  dayForm.querySelector(".primary-button").style.opacity = available ? "1" : ".55";
  document.querySelector("#day-form-note").textContent = available
    ? "선택한 주의 월요일부터 일요일 사이 날짜를 추가할 수 있어요."
    : "이번 주의 날짜가 모두 보드에 있어요.";
  dayDialog.showModal();
}

dayForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const formData = new FormData(dayForm);
  const date = String(formData.get("date"));
  const allowed = weekDates().some((item) => dateKey(item) === date);
  if (!allowed || state.days.some((day) => day.date === date)) {
    showToast("이번 주에 추가할 수 있는 날짜를 선택해 주세요.");
    return;
  }
  state.days.push({ date, kind: "special", name: "" });
  saveWeek();
  render();
  dayDialog.close();
  daysTrack.lastElementChild?.scrollIntoView({ behavior: "smooth", block: "center" });
});

document.querySelector("#open-day-dialog").addEventListener("click", openDayDialog);
document.querySelector("#open-calendar-dialog").addEventListener("click", openCalendarDialog);
document.querySelector("#previous-week").addEventListener("click", () => changeWeek(-1));
document.querySelector("#next-week").addEventListener("click", () => changeWeek(1));
document.querySelector("#previous-month").addEventListener("click", () => changeCalendarMonth(-1));
document.querySelector("#next-month").addEventListener("click", () => changeCalendarMonth(1));
calendarMonth.addEventListener("change", () => {
  const [year, month] = calendarMonth.value.split("-").map(Number);
  if (!year || !month) return;
  calendarDate = new Date(year, month - 1, 1);
  renderCalendar();
});
document.querySelectorAll(".close-dialog").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});

function choosePhoto(day, meal) {
  photoTarget = { day, meal };
  photoFile.click();
}

photoFile.addEventListener("change", async () => {
  const file = photoFile.files && photoFile.files[0];
  photoFile.value = "";
  if (!file || !photoTarget) return;
  if (!file.type.startsWith("image/")) {
    showToast("이미지 파일을 선택해 주세요.");
    return;
  }
  try {
    const imageBlob = await compressImage(file);
    if (cropObjectUrl) URL.revokeObjectURL(cropObjectUrl);
    cropObjectUrl = URL.createObjectURL(imageBlob);
    cropImage.src = cropObjectUrl;
    photoZoom.value = "1";
    setCropTransform(1, 50, 50);
    photoDialog.showModal();
  } catch (error) {
    console.error("사진을 준비하지 못했습니다.", error);
    showToast("사진을 열지 못했어요. 다른 이미지를 선택해 주세요.");
  }
});

function compressImage(file) {
  return createImageBitmap(file).then((bitmap) => {
    const maxSide = 1800;
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Image encoding failed"));
      }, "image/jpeg", 0.88);
    });
  });
}

function setCropTransform(zoom, x, y) {
  cropImage.style.objectPosition = `${x}% ${y}%`;
  cropImage.style.transform = `scale(${zoom})`;
  cropImage.dataset.x = String(x);
  cropImage.dataset.y = String(y);
}

photoZoom.addEventListener("input", () => {
  setCropTransform(Number(photoZoom.value), Number(cropImage.dataset.x || 50), Number(cropImage.dataset.y || 50));
});

cropStage.addEventListener("pointerdown", (event) => {
  cropPointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
  cropStage.setPointerCapture(event.pointerId);
});
cropStage.addEventListener("pointermove", (event) => {
  if (!cropPointer || cropPointer.id !== event.pointerId) return;
  const zoom = Number(photoZoom.value);
  const width = cropStage.clientWidth;
  const height = cropStage.clientHeight;
  const scale = Math.max(width / cropImage.naturalWidth, height / cropImage.naturalHeight) * zoom;
  const overflowX = Math.max(1, cropImage.naturalWidth * scale - width);
  const overflowY = Math.max(1, cropImage.naturalHeight * scale - height);
  const x = Math.max(0, Math.min(100, Number(cropImage.dataset.x || 50) - (event.clientX - cropPointer.x) / overflowX * 100));
  const y = Math.max(0, Math.min(100, Number(cropImage.dataset.y || 50) - (event.clientY - cropPointer.y) / overflowY * 100));
  setCropTransform(zoom, x, y);
  cropPointer.x = event.clientX;
  cropPointer.y = event.clientY;
});
cropStage.addEventListener("pointerup", () => { cropPointer = null; });
cropStage.addEventListener("pointercancel", () => { cropPointer = null; });

photoForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!photoTarget || !cropObjectUrl) return;
  const { day, meal } = photoTarget;
  const plan = planFor(day, meal);
  const photoKey = `${storageKey()}:${day}:${meal}`;
  try {
    await storePhoto(photoKey, await (await fetch(cropObjectUrl)).blob());
    plan.photo = {
      key: photoKey,
      uploadedAt: Date.now(),
      zoom: Number(photoZoom.value),
      x: Number(cropImage.dataset.x || 50),
      y: Number(cropImage.dataset.y || 50),
    };
    saveWeek();
    render();
    photoDialog.close();
    URL.revokeObjectURL(cropObjectUrl);
    cropObjectUrl = null;
  } catch (error) {
    console.error("사진을 저장하지 못했습니다.", error);
    showToast("사진을 저장하지 못했어요. 브라우저 저장 공간을 확인해 주세요.");
  }
});

photoDialog.addEventListener("close", () => {
  cropPointer = null;
  if (cropObjectUrl) {
    URL.revokeObjectURL(cropObjectUrl);
    cropObjectUrl = null;
  }
});

async function clearPhoto(day, meal) {
  const plan = planFor(day, meal);
  if (plan.photo) {
    try {
      await deletePhoto(plan.photo.key);
    } catch (error) {
      console.error("사진을 삭제하지 못했습니다.", error);
      showToast("사진을 삭제하지 못했어요.");
      return;
    }
  }
  plan.photo = null;
  saveWeek();
  render();
}

function openPhotoDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("weekends-media-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("photos");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
  });
}

async function storePhoto(key, blob) {
  const db = await openPhotoDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("photos", "readwrite");
    transaction.objectStore("photos").put(blob, key);
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(transaction.error || new Error("Photo save failed")); };
    transaction.onabort = () => { db.close(); reject(transaction.error || new Error("Photo save aborted")); };
  });
}

async function loadPhoto(key) {
  const db = await openPhotoDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("photos", "readonly");
    const request = transaction.objectStore("photos").get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("Photo load failed"));
    transaction.oncomplete = () => db.close();
  });
}

async function deletePhoto(key) {
  const db = await openPhotoDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction("photos", "readwrite");
    transaction.objectStore("photos").delete(key);
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(transaction.error || new Error("Photo delete failed")); };
  });
}

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error) => console.error("오프라인 저장을 시작하지 못했습니다.", error));
  });
}

initializeSupabase();
