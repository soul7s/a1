const STORAGE_KEY = "moim-treasurer-board-v1";
const STORAGE_META_KEY = "moim-treasurer-board-v1-meta";
const LOCAL_DB_NAME = "moim-treasurer-board-db";
const LOCAL_DB_VERSION = 1;
const LOCAL_STORE_NAME = "snapshots";
const LOCAL_RECORD_KEY = "app-state";
const SHARED_STATE_KEYS = [
  "groups",
  "settings",
  "members",
  "dues",
  "assignments",
  "deposits",
  "incomeEntries",
  "expenses",
  "closings",
  "history",
  "tempMeetings",
  "tempMeetingExpenses",
  "tempMeetingPayments",
  "tempMeetingAdjustments",
];
const API_BASE = "./api";
const CONFIRMED_PAYMENT_STATUSES = new Set(["납부 완료", "부분 납부"]);
const YEAR_MONTH_LABELS = Array.from({ length: 12 }, (_, index) => `${index + 1}월`);
const DEMO_JOIN_DATES = {
  김민서: "2026-01-05",
  이준호: "2026-01-14",
  박서윤: "2026-03-01",
  정도윤: "2026-02-10",
  최하린: "2026-01-28",
  오지안: "2025-11-10",
  강태오: "2026-01-03",
  송유진: "2026-01-15",
  한지석: "2026-02-01",
  임시후: "2026-03-04",
  배서후: "2026-01-21",
};
const TAB_META = [
  { id: "dashboard", label: "대시보드", hint: "잔액과 우선 처리" },
  { id: "members", label: "회원", hint: "회비 대상 관리" },
  { id: "dues", label: "회비", hint: "회비 생성과 납부 현황" },
  { id: "deposits", label: "입금", hint: "입금 등록과 대조" },
  { id: "expenses", label: "지출", hint: "지출 기록과 증빙" },
  { id: "settings", label: "설정", hint: "기초잔액과 카테고리" },
];
const EXTRA_TAB_META = [
  { id: "submeetings", label: "소모임", hint: "임시모임 정산과 반영" },
  { id: "closing", label: "월 마감", hint: "정산과 재오픈" },
  { id: "history", label: "이력", hint: "변경 로그 추적" },
];

const DEFAULT_FILTERS = {
  memberQuery: "",
  memberStatus: "all",
  memberEligibility: "all",
  dueAssignmentStatus: "all",
  depositStatus: "all",
  expenseQuery: "",
  expenseCategory: "all",
  historyType: "all",
  historyAction: "all",
};

const syncState = {
  clientId: uid("client"),
  available: false,
  status: "local",
  revision: 0,
  lastSyncedAt: "",
  lastLocalSavedAt: "",
  localStorageLabel: "브라우저 저장",
  localDbReady: false,
  localSaveError: false,
  localSaveTimer: null,
  localDb: null,
  saveTimer: null,
  isPulling: false,
  isPushing: false,
  applyingRemote: false,
  pendingPush: false,
  eventSource: null,
};

const state = loadState();

initialize();

function initialize() {
  hydrateState();
  bindEvents();
  renderApp();
  void initializeBackgroundServices();
}

async function initializeBackgroundServices() {
  await initializeLocalPersistence();
  await initializeRemoteSync();
}

function bindEvents() {
  document.addEventListener("click", handleClick);
  document.addEventListener("submit", handleSubmit);
  document.addEventListener("change", handleChange);
}

function loadState() {
  try {
    const rawMeta = window.localStorage.getItem(STORAGE_META_KEY);
    if (rawMeta) {
      const meta = JSON.parse(rawMeta);
      syncState.lastLocalSavedAt = meta.savedAt || "";
    }
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return createSeedState();
    }
    return JSON.parse(raw);
  } catch (error) {
    return createSeedState();
  }
}

function writeBrowserSnapshot(snapshotState, savedAt) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshotState));
    window.localStorage.setItem(
      STORAGE_META_KEY,
      JSON.stringify({
        savedAt,
      }),
    );
    syncState.lastLocalSavedAt = savedAt;
    syncState.localSaveError = false;
    return true;
  } catch (error) {
    syncState.localSaveError = true;
    console.error("Failed to save state", error);
    return false;
  }
}

function saveState(options = {}) {
  const savedAt = isoNow();
  writeBrowserSnapshot(state, savedAt);

  if (!options.skipLocalDb) {
    queueLocalDatabaseSave(savedAt);
  }

  if (!options.skipRemote) {
    queueRemoteSave();
  }

  renderSyncIndicator();
}

async function initializeLocalPersistence() {
  if (typeof window.indexedDB === "undefined") {
    syncState.localDbReady = false;
    syncState.localStorageLabel = "브라우저 저장";
    renderSyncIndicator();
    return;
  }

  try {
    syncState.localDb = await openLocalDatabase();
    syncState.localDbReady = true;
    syncState.localStorageLabel = "IndexedDB + 브라우저 저장";

    const snapshot = await readLocalSnapshot();
    if (isValidLocalSnapshot(snapshot)) {
      const shouldRestore =
        !syncState.lastLocalSavedAt || isSavedAtNewer(snapshot.savedAt, syncState.lastLocalSavedAt);
      if (shouldRestore) {
        applyLocalSnapshot(snapshot.state, snapshot.savedAt);
        return;
      }
    }

    queueLocalDatabaseSave(syncState.lastLocalSavedAt || isoNow());
  } catch (error) {
    syncState.localDbReady = false;
    syncState.localDb = null;
    syncState.localStorageLabel = "브라우저 저장";
    console.error("Failed to initialize local persistence", error);
  } finally {
    renderSyncIndicator();
  }
}

function openLocalDatabase() {
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(LOCAL_DB_NAME, LOCAL_DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(LOCAL_STORE_NAME)) {
        database.createObjectStore(LOCAL_STORE_NAME, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
  });
}

function readLocalSnapshot() {
  return new Promise((resolve, reject) => {
    if (!syncState.localDb) {
      resolve(null);
      return;
    }

    const transaction = syncState.localDb.transaction(LOCAL_STORE_NAME, "readonly");
    const store = transaction.objectStore(LOCAL_STORE_NAME);
    const request = store.get(LOCAL_RECORD_KEY);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error || new Error("IndexedDB read failed"));
  });
}

function writeLocalSnapshot(snapshot) {
  return new Promise((resolve, reject) => {
    if (!syncState.localDb) {
      resolve(false);
      return;
    }

    const transaction = syncState.localDb.transaction(LOCAL_STORE_NAME, "readwrite");
    const store = transaction.objectStore(LOCAL_STORE_NAME);
    const request = store.put({
      key: LOCAL_RECORD_KEY,
      savedAt: snapshot.savedAt,
      state: cloneJson(snapshot.state),
    });

    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error || new Error("IndexedDB write failed"));
  });
}

function queueLocalDatabaseSave(savedAt = "") {
  if (!syncState.localDbReady || !syncState.localDb) {
    return;
  }

  window.clearTimeout(syncState.localSaveTimer);
  syncState.localSaveTimer = window.setTimeout(() => {
    void persistLocalSnapshot(savedAt || syncState.lastLocalSavedAt || isoNow());
  }, 220);
}

async function persistLocalSnapshot(savedAt) {
  if (!syncState.localDbReady || !syncState.localDb) {
    return;
  }

  try {
    await writeLocalSnapshot({
      savedAt,
      state,
    });
    syncState.lastLocalSavedAt = savedAt;
    syncState.localSaveError = false;
  } catch (error) {
    syncState.localSaveError = true;
    console.error("Failed to persist local snapshot", error);
  } finally {
    renderSyncIndicator();
  }
}

function applyLocalSnapshot(snapshotState, savedAt) {
  if (!isValidStateSnapshot(snapshotState)) {
    return;
  }

  Object.keys(state).forEach((key) => delete state[key]);
  Object.assign(state, cloneJson(snapshotState));
  hydrateState();
  writeBrowserSnapshot(state, savedAt || isoNow());
  renderApp();
}

function isValidLocalSnapshot(snapshot) {
  return (
    snapshot &&
    typeof snapshot === "object" &&
    snapshot.key === LOCAL_RECORD_KEY &&
    isValidStateSnapshot(snapshot.state)
  );
}

function isValidStateSnapshot(snapshotState) {
  return Boolean(
    snapshotState &&
      typeof snapshotState === "object" &&
      Array.isArray(snapshotState.groups) &&
      snapshotState.ui &&
      typeof snapshotState.ui === "object",
  );
}

function isSavedAtNewer(candidate, current) {
  const candidateTime = Date.parse(candidate || "");
  const currentTime = Date.parse(current || "");
  if (!Number.isFinite(candidateTime)) {
    return false;
  }
  if (!Number.isFinite(currentTime)) {
    return true;
  }
  return candidateTime > currentTime;
}

function createDepositDraft(overrides = {}) {
  const hasDueOverride = Object.prototype.hasOwnProperty.call(overrides, "dueId");
  const hasStatusOverride = Object.prototype.hasOwnProperty.call(overrides, "status");
  const memberId = Object.prototype.hasOwnProperty.call(overrides, "memberId") ? overrides.memberId : "";
  const dueId = hasDueOverride ? overrides.dueId : state?.ui?.selectedDueId || "";
  const status = hasStatusOverride ? overrides.status : "납부 완료";

  return {
    memberId: memberId || "",
    dueId: dueId || "",
    status: status || "납부 완료",
  };
}

async function initializeRemoteSync() {
  renderSyncIndicator();

  const health = await fetchApiJSON(`${API_BASE}/health`);
  if (!health) {
    syncState.available = false;
    syncState.status = "local";
    renderSyncIndicator();
    return;
  }

  syncState.available = true;
  syncState.status = "connecting";
  renderSyncIndicator();

  const remotePayload = await fetchApiJSON(`${API_BASE}/state`);
  if (remotePayload?.exists && hasMeaningfulSharedState(remotePayload.sharedState)) {
    syncState.revision = asNumber(remotePayload.revision);
    syncState.lastSyncedAt = remotePayload.updatedAt || "";
    applySharedState(remotePayload.sharedState);
  } else {
    await pushRemoteSave({ immediate: true });
  }

  openRemoteEventStream();
  syncState.status = "live";
  renderSyncIndicator();
}

function queueRemoteSave() {
  if (!syncState.available || syncState.applyingRemote) {
    return;
  }

  syncState.pendingPush = true;
  window.clearTimeout(syncState.saveTimer);
  syncState.saveTimer = window.setTimeout(() => {
    void pushRemoteSave();
  }, 320);
}

async function pushRemoteSave(options = {}) {
  if (!syncState.available) {
    return;
  }

  if (syncState.isPushing && !options.immediate) {
    syncState.pendingPush = true;
    return;
  }

  syncState.isPushing = true;
  syncState.pendingPush = false;
  syncState.status = "saving";
  renderSyncIndicator();

  try {
    const response = await fetch(`${API_BASE}/state`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      cache: "no-store",
      body: JSON.stringify({
        clientId: syncState.clientId,
        revision: syncState.revision,
        sharedState: getSharedStateSnapshot(),
      }),
    });
    if (!response.ok) {
      throw new Error(`Remote save failed: ${response.status}`);
    }

    const payload = await response.json();
    syncState.revision = asNumber(payload.revision);
    syncState.lastSyncedAt = payload.updatedAt || "";
    syncState.status = "live";
  } catch (error) {
    syncState.status = "error";
    console.error(error);
  } finally {
    syncState.isPushing = false;
    renderSyncIndicator();
    if (syncState.pendingPush) {
      syncState.pendingPush = false;
      queueRemoteSave();
    }
  }
}

function openRemoteEventStream() {
  if (!syncState.available || typeof window.EventSource !== "function") {
    return;
  }

  syncState.eventSource?.close();
  const source = new EventSource(`${API_BASE}/events`);
  syncState.eventSource = source;

  source.addEventListener("open", () => {
    syncState.status = "live";
    renderSyncIndicator();
  });

  source.addEventListener("ready", (event) => {
    updateRemoteRevision(event.data);
  });

  source.addEventListener("state", (event) => {
    updateRemoteRevision(event.data);
    void pullRemoteSharedState(event.data);
  });

  source.onerror = () => {
    syncState.status = "reconnecting";
    renderSyncIndicator();
  };
}

async function pullRemoteSharedState(eventData = "") {
  if (!syncState.available || syncState.isPulling || syncState.isPushing) {
    return;
  }

  let eventPayload = null;
  if (eventData) {
    try {
      eventPayload = JSON.parse(eventData);
    } catch (error) {
      eventPayload = null;
    }
  }

  if (eventPayload?.clientId && eventPayload.clientId === syncState.clientId) {
    return;
  }

  syncState.isPulling = true;
  syncState.status = "connecting";
  renderSyncIndicator();

  try {
    const payload = await fetchApiJSON(`${API_BASE}/state`);
    if (!payload?.exists || !hasMeaningfulSharedState(payload.sharedState)) {
      return;
    }

    syncState.revision = asNumber(payload.revision);
    syncState.lastSyncedAt = payload.updatedAt || "";
    applySharedState(payload.sharedState);
    syncState.status = "live";
  } catch (error) {
    syncState.status = "error";
    console.error(error);
  } finally {
    syncState.isPulling = false;
    renderSyncIndicator();
  }
}

function applySharedState(sharedState) {
  const preservedUi = cloneJson(state.ui || {});

  SHARED_STATE_KEYS.forEach((key) => {
    state[key] = cloneJson(sharedState?.[key] ?? defaultSharedStateValue(key));
  });

  state.ui = preservedUi;
  syncState.applyingRemote = true;
  try {
    hydrateState();
    saveState({ skipRemote: true });
  } finally {
    syncState.applyingRemote = false;
  }
  renderApp();
}

function getSharedStateSnapshot() {
  return cloneJson(
    SHARED_STATE_KEYS.reduce((snapshot, key) => {
      snapshot[key] = state[key];
      return snapshot;
    }, {}),
  );
}

function hasMeaningfulSharedState(sharedState) {
  if (!sharedState || typeof sharedState !== "object") {
    return false;
  }

  return SHARED_STATE_KEYS.some((key) => {
    const value = sharedState[key];
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    if (key === "settings") {
      return Boolean(value) && (Array.isArray(value.categories) ? value.categories.length > 0 : Object.keys(value).length > 0);
    }
    return Boolean(value);
  });
}

function defaultSharedStateValue(key) {
  if (key === "settings") {
    return {
      initialOpeningBalance: 0,
      categories: [],
    };
  }
  return [];
}

async function fetchApiJSON(url) {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
      },
      cache: "no-store",
    });
    if (!response.ok) {
      return null;
    }
    return response.json();
  } catch (error) {
    return null;
  }
}

function updateRemoteRevision(eventData) {
  if (!eventData) {
    return;
  }

  try {
    const payload = JSON.parse(eventData);
    syncState.revision = Math.max(syncState.revision, asNumber(payload.revision));
    syncState.lastSyncedAt = payload.updatedAt || syncState.lastSyncedAt;
    renderSyncIndicator();
  } catch (error) {
    console.error("Failed to parse remote event", error);
  }
}

function renderSyncIndicator() {
  const indicator = document.getElementById("sync-indicator");
  if (!indicator) {
    return;
  }

  const meta = getSyncIndicatorMeta();
  indicator.className = `sync-indicator ${meta.className}`;
  indicator.textContent = meta.text;
  indicator.title = meta.title;
}

function getSyncIndicatorMeta() {
  const syncedAt = formatSyncTime(syncState.lastSyncedAt);
  const localSavedAt = formatSyncTime(syncState.lastLocalSavedAt);

  if (!syncState.available && syncState.localSaveError) {
    return {
      className: "is-danger",
      text: "기기 저장 확인 필요",
      title: "이 기기 저장 중 일부 문제가 있었습니다. 브라우저를 새로고침한 뒤 다시 확인하세요.",
    };
  }

  switch (syncState.status) {
    case "connecting":
      return {
        className: "is-connecting",
        text: "서버 동기화 준비 중",
        title: "서버에서 최신 데이터를 불러오는 중입니다.",
      };
    case "saving":
      return {
        className: "is-saving",
        text: "실시간 저장 중",
        title: "변경 내용을 서버에 저장하는 중입니다.",
      };
    case "reconnecting":
      return {
        className: "is-warning",
        text: "재연결 중",
        title: "실시간 연결이 잠시 끊겨 다시 연결하는 중입니다.",
      };
    case "error":
      return {
        className: "is-danger",
        text: "서버 저장 실패",
        title: "네트워크 또는 서버 상태를 확인하세요.",
      };
    case "live":
      return {
        className: "is-live",
        text: syncedAt ? `실시간 연동 중 · ${syncedAt}` : "실시간 연동 중",
        title: "다른 기기의 변경 내용이 자동 반영됩니다.",
      };
    default:
      return {
        className: "is-local",
        text: localSavedAt ? `이 기기 자동 저장 · ${localSavedAt}` : "이 기기 자동 저장",
        title: syncState.localDbReady
          ? "현재는 서버 없이 이 기기 안에 자동 저장됩니다. IndexedDB와 브라우저 저장을 함께 사용합니다."
          : "현재는 서버 없이 이 기기 브라우저 저장소에 저장됩니다.",
      };
  }
}

function formatSyncTime(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function createSeedState() {
  const period = currentPeriod();
  const previous = shiftPeriod(period, -1);
  const groups = [
    createGroupRecord({
      name: "독서모임",
      description: "월 1회 책 토론과 간식 정산",
      kind: "정규모임",
      initialOpeningBalance: 350000,
      regularMonthlyFee: 30000,
    }),
    createGroupRecord({
      name: "풋살모임",
      description: "주말 풋살장 대관과 회식 정산",
      kind: "정규모임",
      initialOpeningBalance: 520000,
      regularMonthlyFee: 50000,
    }),
  ];

  const readingBundle = createDemoBundle(groups[0], period, previous, {
    memberSeeds: [
      ["김민서", "민서", "010-1111-2222", "김민서", "정기 회비 자동 입금 스타일", true, "활성", "2026-01-05"],
      ["이준호", "준호", "010-2222-3333", "준호", "입금자명 짧게 찍힘", true, "활성", "2026-01-14"],
      ["박서윤", "서윤", "010-3333-4444", "박서윤", "이번 달 부분 납부 예정", true, "활성", "2026-03-01"],
      ["정도윤", "도윤", "010-4444-5555", "정도윤", "이번 달 회비 면제", true, "활성", "2026-02-10"],
      ["최하린", "하린", "010-5555-6666", "HARIN", "", true, "활성", "2026-01-28"],
      ["오지안", "지안", "010-6666-7777", "오지안", "휴면 회원", true, "비활성", "2025-11-10"],
    ],
    categoryNames: ["식비", "대관료", "운영비", "기타"],
    duesSeeds: [
      { title: `${monthLabel(period)} 정기 회비`, type: "월회비", amount: 30000, day: 20, note: "총무 기본 회비", count: 999 },
      { title: `${monthLabel(period)} 봄 모임 참가비`, type: "행사비", amount: 20000, day: 15, note: "장소 대관 보전", count: 4 },
    ],
    depositsSeed: [
      [0, 0, 2, 30000, "김민서", "납부 완료", "정기 입금"],
      [1, 0, 3, 30000, "준호", "납부 완료", ""],
      [2, 0, 5, 15000, "박서윤", "부분 납부", "나머지 다음 주"],
      [0, 1, 6, 20000, "김민서", "납부 완료", ""],
      [null, null, 7, 30000, "JH-PARENT", "확인 필요", "입금자 확인 필요"],
    ],
    expensesSeed: [
      [4, 45000, "대관료", "한강 모임실", "3월 정기모임", "2시간 대관", "room-rental-march.pdf"],
      [6, 38000, "식비", "샌드위치 가게", "정기모임 간식", "", "snack-order.jpg"],
      [8, 12000, "운영비", "다이소", "명찰, 펜", "", ""],
    ],
    previousClosing: {
      openingBalance: 270000,
      income: 180000,
      expense: 100000,
      closingBalance: 350000,
    },
    exemptNickname: "도윤",
  });

  const futsalBundle = createDemoBundle(groups[1], period, previous, {
    memberSeeds: [
      ["강태오", "태오", "010-7777-1111", "강태오", "", true, "활성", "2026-01-03"],
      ["송유진", "유진", "010-7777-2222", "송유진", "", true, "활성", "2026-01-15"],
      ["한지석", "지석", "010-7777-3333", "HAN JI", "가끔 보호자 명의 입금", true, "활성", "2026-02-01"],
      ["임시후", "시후", "010-7777-4444", "시후", "", true, "활성", "2026-03-04"],
      ["배서후", "서후", "010-7777-5555", "배서후", "", true, "활성", "2026-01-21"],
    ],
    categoryNames: ["대관료", "식비", "장비비", "기타"],
    duesSeeds: [
      { title: `${monthLabel(period)} 풋살장 대관비`, type: "월회비", amount: 50000, day: 10, note: "주말 2회 대관", count: 5 },
      { title: `${monthLabel(period)} 뒤풀이 회비`, type: "행사비", amount: 25000, day: 18, note: "치킨 회식", count: 3 },
    ],
    depositsSeed: [
      [0, 0, 2, 50000, "강태오", "납부 완료", ""],
      [1, 0, 2, 50000, "송유진", "납부 완료", ""],
      [2, 0, 3, 50000, "HAN JI", "납부 완료", ""],
      [3, 0, 6, 25000, "시후", "부분 납부", "남은 금액 추후 입금"],
      [null, null, 9, 50000, "PARK-ACCOUNT", "확인 필요", "선수 확인 전"],
    ],
    expensesSeed: [
      [3, 160000, "대관료", "강남 풋살장", "주말 2회", "", "futsal-rental.pdf"],
      [9, 52000, "장비비", "스포츠샵", "팀 조끼", "", "vests.png"],
      [12, 43000, "식비", "치킨집", "경기 후 식사", "", ""],
    ],
    previousClosing: {
      openingBalance: 430000,
      income: 240000,
      expense: 150000,
      closingBalance: 520000,
    },
    exemptNickname: "",
  });

  const seedState = {
    groups,
    settings: {
      initialOpeningBalance: groups[0].initialOpeningBalance,
      categories: [...readingBundle.categories, ...futsalBundle.categories],
    },
    members: [...readingBundle.members, ...futsalBundle.members],
    dues: [...readingBundle.dues, ...futsalBundle.dues],
    assignments: [...readingBundle.assignments, ...futsalBundle.assignments],
    deposits: [...readingBundle.deposits, ...futsalBundle.deposits],
    incomeEntries: [],
    expenses: [...readingBundle.expenses, ...futsalBundle.expenses],
    closings: [...readingBundle.closings, ...futsalBundle.closings],
    history: [...readingBundle.history, ...futsalBundle.history].sort((left, right) =>
      right.at.localeCompare(left.at),
    ),
    tempMeetings: [],
    tempMeetingExpenses: [],
    tempMeetingPayments: [],
    tempMeetingAdjustments: [],
    ui: {
      currentTab: "dashboard",
      selectedGroupId: groups[0].id,
      selectedPeriod: period,
      selectedDueId: readingBundle.dues[0]?.id || "",
      selectedTempMeetingId: "",
      filters: { ...DEFAULT_FILTERS },
      editing: {
        memberId: "",
        dueId: "",
        depositId: "",
        incomeId: "",
        expenseId: "",
      },
      depositDraft: createDepositDraft({
        dueId: readingBundle.dues[0]?.id || "",
      }),
      flash: {
        type: "info",
        message: "샘플 데이터가 준비되었습니다. 총무 실무 흐름을 바로 테스트할 수 있습니다.",
      },
    },
  };

  const sampleTempMeeting = createTempMeetingRecord({
    groupId: groups[0].id,
    name: "봄 번개 소모임",
    date: dateInPeriod(period, 9),
    participantIds: readingBundle.members.slice(0, 3).map((member) => member.id),
    note: "카페와 저녁 비용을 따로 정산하는 임시모임",
  });
  seedState.tempMeetings.push(sampleTempMeeting);
  seedState.tempMeetingExpenses.push(
    createTempMeetingExpenseRecord({
      groupId: groups[0].id,
      tempMeetingId: sampleTempMeeting.id,
      date: dateInPeriod(period, 9),
      amount: 48000,
      category: "식비",
      vendor: "브런치 카페",
      purpose: "점심 식사",
      participantIds: sampleTempMeeting.participantIds,
    }),
    createTempMeetingExpenseRecord({
      groupId: groups[0].id,
      tempMeetingId: sampleTempMeeting.id,
      date: dateInPeriod(period, 9),
      amount: 18000,
      category: "기타",
      vendor: "택시",
      purpose: "이동비",
      participantIds: [sampleTempMeeting.participantIds[0], sampleTempMeeting.participantIds[2]],
    }),
  );
  seedState.tempMeetingPayments.push(
    createTempMeetingPaymentRecord({
      groupId: groups[0].id,
      tempMeetingId: sampleTempMeeting.id,
      memberId: sampleTempMeeting.participantIds[0],
      date: dateInPeriod(period, 10),
      amount: 20000,
      note: "선입금",
    }),
    createTempMeetingPaymentRecord({
      groupId: groups[0].id,
      tempMeetingId: sampleTempMeeting.id,
      memberId: sampleTempMeeting.participantIds[1],
      date: dateInPeriod(period, 10),
      amount: 16000,
      note: "",
    }),
  );
  seedState.tempMeetingAdjustments.push(
    createTempMeetingAdjustmentRecord({
      groupId: groups[0].id,
      tempMeetingId: sampleTempMeeting.id,
      memberId: sampleTempMeeting.participantIds[2],
      amount: -3000,
      reason: "카페 음료 미주문",
    }),
  );
  seedState.ui.selectedTempMeetingId = sampleTempMeeting.id;

  recalculateAllAssignments(seedState);
  return seedState;
}

function createGroupRecord(payload) {
  return {
    id: uid("group"),
    name: payload.name,
    description: payload.description || "",
    kind: payload.kind || "정규모임",
    initialOpeningBalance: asNumber(payload.initialOpeningBalance),
    regularMonthlyFee: asNumber(payload.regularMonthlyFee),
  };
}

function createDemoBundle(group, period, previous, config) {
  const members = config.memberSeeds.map(
    ([name, nickname, contact, payerName, memo, duesEligible, status, joinDate]) => ({
      id: uid("member"),
      groupId: group.id,
      name,
      nickname,
      contact,
      payerName,
      joinDate: normalizeDateValue(joinDate || ""),
      duesEligible,
      status,
      memo,
    }),
  );

  const categories = config.categoryNames.map((name) => ({
    id: uid("cat"),
    groupId: group.id,
    name,
    active: true,
  }));

  const dues = config.duesSeeds.map((seed) => {
    const targets = members.filter(isEligibleMember).slice(0, seed.count).map((member) => member.id);
    return {
      id: uid("due"),
      groupId: group.id,
      title: seed.title,
      type: seed.type,
      amount: seed.amount,
      period,
      dueDate: dateInPeriod(period, seed.day),
      targetMemberIds: targets,
      note: seed.note,
      createdAt: isoNow(),
    };
  });

  const assignments = dues.flatMap((due) =>
    due.targetMemberIds.map((memberId) => createAssignment(group.id, due.id, memberId)),
  );

  if (config.exemptNickname) {
    const exemptMember = members.find((member) => member.nickname === config.exemptNickname);
    const firstDue = dues[0];
    const assignment = assignments.find(
      (item) => item.memberId === exemptMember?.id && item.dueId === firstDue?.id,
    );
    if (assignment) {
      assignment.manualStatus = "면제";
      assignment.status = "면제";
    }
  }

  const deposits = config.depositsSeed.map(([memberIndex, dueIndex, day, amount, payerName, status, memo]) =>
    createDepositRecord({
      groupId: group.id,
      memberId: memberIndex === null ? "" : members[memberIndex]?.id || "",
      dueId: dueIndex === null ? "" : dues[dueIndex]?.id || "",
      date: dateInPeriod(period, day),
      amount,
      payerName,
      status,
      memo,
    }),
  );

  const expenses = config.expensesSeed.map(
    ([day, amount, category, vendor, purpose, memo, receiptName]) =>
      createExpenseRecord({
        groupId: group.id,
        date: dateInPeriod(period, day),
        amount,
        category,
        vendor,
        purpose,
        memo,
        receiptName,
      }),
  );

  const closings = [
    {
      id: uid("close"),
      groupId: group.id,
      period: previous,
      openingBalance: config.previousClosing.openingBalance,
      income: config.previousClosing.income,
      expense: config.previousClosing.expense,
      closingBalance: config.previousClosing.closingBalance,
      status: "마감 완료",
      closedAt: `${previous}-28T21:10:00`,
      reopenedAt: "",
    },
  ];

  const history = [
    createHistoryEntry({
      groupId: group.id,
      entityType: "정산",
      entityId: closings[0].id,
      entityLabel: `${monthLabel(previous)} 월 마감`,
      action: "마감",
      summary: `${monthLabel(previous)} 마감 완료`,
      actor: "샘플 데이터",
      at: `${previous}-28T21:10:00`,
    }),
    createHistoryEntry({
      groupId: group.id,
      entityType: "설정",
      entityId: `opening-balance-${group.id}`,
      entityLabel: "기초잔액",
      action: "설정",
      summary: `${group.name} 기초잔액 ${formatCurrency(group.initialOpeningBalance)} 설정`,
      actor: "샘플 데이터",
      at: `${previous}-01T09:00:00`,
    }),
  ];

  const bundleState = { dues, assignments, deposits };
  recalculateAllAssignments(bundleState);

  return {
    members,
    categories,
    dues,
    assignments,
    deposits,
    expenses,
    closings,
    history,
  };
}

function hydrateState() {
  state.groups = Array.isArray(state.groups) ? state.groups : [];
  state.settings = state.settings || {};
  state.settings.initialOpeningBalance = asNumber(state.settings.initialOpeningBalance);
  state.settings.categories = Array.isArray(state.settings.categories)
    ? state.settings.categories
    : [];

  state.members = Array.isArray(state.members) ? state.members : [];
  state.dues = Array.isArray(state.dues) ? state.dues : [];
  state.assignments = Array.isArray(state.assignments) ? state.assignments : [];
  state.deposits = Array.isArray(state.deposits) ? state.deposits : [];
  state.incomeEntries = Array.isArray(state.incomeEntries) ? state.incomeEntries : [];
  state.expenses = Array.isArray(state.expenses) ? state.expenses : [];
  state.closings = Array.isArray(state.closings) ? state.closings : [];
  state.history = Array.isArray(state.history) ? state.history : [];
  state.tempMeetings = Array.isArray(state.tempMeetings) ? state.tempMeetings : [];
  state.tempMeetingExpenses = Array.isArray(state.tempMeetingExpenses) ? state.tempMeetingExpenses : [];
  state.tempMeetingPayments = Array.isArray(state.tempMeetingPayments) ? state.tempMeetingPayments : [];
  state.tempMeetingAdjustments = Array.isArray(state.tempMeetingAdjustments)
    ? state.tempMeetingAdjustments
    : [];

  migrateLegacySingleGroupState();

  state.ui = state.ui || {};
  state.ui.currentTab = state.ui.currentTab || "dashboard";
  state.ui.selectedGroupId = state.ui.selectedGroupId || state.groups[0]?.id || "";
  state.ui.selectedPeriod = state.ui.selectedPeriod || currentPeriod();
  state.ui.selectedDueId = state.ui.selectedDueId || "";
  state.ui.selectedTempMeetingId = state.ui.selectedTempMeetingId || "";
  state.ui.filters = { ...DEFAULT_FILTERS, ...(state.ui.filters || {}) };
  state.ui.editing = {
    memberId: "",
    dueId: "",
    depositId: "",
    incomeId: "",
    expenseId: "",
    ...(state.ui.editing || {}),
  };
  state.ui.depositDraft = {
    ...createDepositDraft(),
    ...(state.ui.depositDraft || {}),
  };
  state.ui.flash = state.ui.flash || null;

  recalculateAllAssignments(state);
  syncSelectedDue();
  syncSelectedTempMeeting();
}

function migrateLegacySingleGroupState() {
  if (!state.groups.length) {
    const group = createGroupRecord({
      name: "모임 1",
      description: "기존 단일 모임 데이터",
      kind: "정규모임",
      initialOpeningBalance: asNumber(state.settings.initialOpeningBalance),
      regularMonthlyFee: getFallbackRegularMonthlyFee(primaryMonthlyDuesFor(state.dues || [])),
    });
    const secondGroup = createGroupRecord({
      name: "모임 2",
      description: "새 정산용 모임",
      kind: "정규모임",
      initialOpeningBalance: 0,
      regularMonthlyFee: 0,
    });
    state.groups = [group, secondGroup];
  }

  const primaryGroupId = state.groups[0].id;

  state.groups = state.groups.map((group) => ({
    ...group,
    kind: group.kind || "정규모임",
    initialOpeningBalance: asNumber(group.initialOpeningBalance),
    regularMonthlyFee: asNumber(group.regularMonthlyFee),
  }));

  state.settings.categories = state.settings.categories.map((category) => ({
    ...category,
    groupId: category.groupId || primaryGroupId,
  }));
  state.members = state.members.map((member) => ({
    ...member,
    groupId: member.groupId || primaryGroupId,
    joinDate: normalizeDateValue(member.joinDate || DEMO_JOIN_DATES[member.name] || ""),
  }));
  state.dues = state.dues.map((due) => ({ ...due, groupId: due.groupId || primaryGroupId }));
  state.groups = state.groups.map((group) => ({
    ...group,
    regularMonthlyFee:
      asNumber(group.regularMonthlyFee) ||
      getFallbackRegularMonthlyFee(primaryMonthlyDuesFor(state.dues.filter((due) => due.groupId === group.id))),
  }));
  state.assignments = state.assignments.map((assignment) => ({
    ...assignment,
    groupId:
      assignment.groupId ||
      state.dues.find((due) => due.id === assignment.dueId)?.groupId ||
      primaryGroupId,
  }));
  state.deposits = state.deposits.map((deposit) => ({
    ...deposit,
    groupId:
      deposit.groupId ||
      state.dues.find((due) => due.id === deposit.dueId)?.groupId ||
      state.members.find((member) => member.id === deposit.memberId)?.groupId ||
      primaryGroupId,
  }));
  state.incomeEntries = state.incomeEntries.map((entry) => ({
    ...entry,
    groupId: entry.groupId || primaryGroupId,
  }));
  state.expenses = state.expenses.map((expense) => ({ ...expense, groupId: expense.groupId || primaryGroupId }));
  state.closings = state.closings.map((closing) => ({ ...closing, groupId: closing.groupId || primaryGroupId }));
  state.history = state.history.map((item) => ({ ...item, groupId: item.groupId || primaryGroupId }));
  state.tempMeetings = state.tempMeetings.map((meeting) => ({ ...meeting, groupId: meeting.groupId || primaryGroupId }));
  state.tempMeetingExpenses = state.tempMeetingExpenses.map((expense) => ({
    ...expense,
    groupId:
      expense.groupId ||
      state.tempMeetings.find((meeting) => meeting.id === expense.tempMeetingId)?.groupId ||
      primaryGroupId,
  }));
  state.tempMeetingPayments = state.tempMeetingPayments.map((payment) => ({
    ...payment,
    groupId:
      payment.groupId ||
      state.tempMeetings.find((meeting) => meeting.id === payment.tempMeetingId)?.groupId ||
      state.members.find((member) => member.id === payment.memberId)?.groupId ||
      primaryGroupId,
  }));
  state.tempMeetingAdjustments = state.tempMeetingAdjustments.map((adjustment) => ({
    ...adjustment,
    groupId:
      adjustment.groupId ||
      state.tempMeetings.find((meeting) => meeting.id === adjustment.tempMeetingId)?.groupId ||
      state.members.find((member) => member.id === adjustment.memberId)?.groupId ||
      primaryGroupId,
  }));
}

function syncSelectedDue() {
  const duesInPeriod = getDuesForPeriod(state.ui.selectedPeriod);
  if (!duesInPeriod.length) {
    state.ui.selectedDueId = "";
    return;
  }
  const hasSelection = duesInPeriod.some((due) => due.id === state.ui.selectedDueId);
  if (!hasSelection) {
    state.ui.selectedDueId = duesInPeriod[0].id;
  }
}

function syncSelectedTempMeeting() {
  const meetings = getTempMeetings();
  if (!meetings.length) {
    state.ui.selectedTempMeetingId = "";
    return;
  }
  const hasSelection = meetings.some((meeting) => meeting.id === state.ui.selectedTempMeetingId);
  if (!hasSelection) {
    state.ui.selectedTempMeetingId = meetings[0].id;
  }
}

function renderApp() {
  syncSelectedDue();
  syncSelectedTempMeeting();
  renderNav();

  const pageMeta = getTabMeta(state.ui.currentTab);
  const pageTitle = document.getElementById("page-title");
  const groupPicker = document.getElementById("group-picker");
  const periodPicker = document.getElementById("period-picker");
  const root = document.getElementById("screen-root");
  const currentGroup = getCurrentGroup();

  pageTitle.textContent = currentGroup ? `${currentGroup.name} · ${pageMeta.label}` : pageMeta.label;
  groupPicker.innerHTML = state.groups
    .map(
      (group) => `
        <option value="${group.id}" ${group.id === state.ui.selectedGroupId ? "selected" : ""}>
          ${escapeHtml(`${group.name} · ${group.kind === "인스턴트모임" ? "인스턴트" : "정규"}`)}
        </option>
      `,
    )
    .join("");
  periodPicker.innerHTML = renderPeriodOptions(state.ui.selectedPeriod);
  root.innerHTML = `${renderFlash()}${renderCurrentTab()}`;
  renderSyncIndicator();
}

function getTabMeta(tabId) {
  return TAB_META.find((tab) => tab.id === tabId) || EXTRA_TAB_META.find((tab) => tab.id === tabId) || TAB_META[0];
}

function renderNav() {
  const nav = document.getElementById("tab-nav");
  const mobileNav = document.getElementById("mobile-tab-nav");
  nav.innerHTML = TAB_META.map(
    (tab) => `
      <button
        class="tab-button ${tab.id === state.ui.currentTab ? "is-active" : ""}"
        data-action="select-tab"
        data-tab="${tab.id}"
        type="button"
      >
        <strong>${tab.label}</strong>
        <span>${tab.hint}</span>
      </button>
    `,
  ).join("");
  if (mobileNav) {
    mobileNav.innerHTML = TAB_META.map(
      (tab) => `
        <button
          class="mobile-tab-button ${tab.id === state.ui.currentTab ? "is-active" : ""}"
          data-action="select-tab"
          data-tab="${tab.id}"
          type="button"
        >
          <strong>${tab.label}</strong>
        </button>
      `,
    ).join("");
  }
}

function renderCurrentTab() {
  switch (state.ui.currentTab) {
    case "members":
      return renderMembers();
    case "dues":
      return renderDues();
    case "deposits":
      return renderDeposits();
    case "expenses":
      return renderExpenses();
    case "submeetings":
      return renderSubmeetings();
    case "closing":
      return renderClosing();
    case "history":
      return renderHistory();
    case "settings":
      return renderSettings();
    case "dashboard":
    default:
      return renderDashboard();
  }
}

function renderFlash() {
  if (!state.ui.flash || !state.ui.flash.message) {
    return "";
  }
  const type = state.ui.flash.type || "info";
  return `
    <section class="alert-box ${type}">
      <div class="section-title">
        <div>
          <h4>${type === "danger" ? "확인 필요" : "안내"}</h4>
          <p>${escapeHtml(state.ui.flash.message)}</p>
        </div>
        <button class="ghost-button" type="button" data-action="close-flash">닫기</button>
      </div>
    </section>
  `;
}

function renderDashboard() {
  const snapshot = getPeriodSnapshot(state.ui.selectedPeriod);
  const closing = getClosingRecord(state.ui.selectedPeriod);
  const recentDeposits = sortDateDesc(getDepositsForPeriod(state.ui.selectedPeriod)).slice(0, 4);
  const recentExpenses = sortDateDesc(getExpensesForPeriod(state.ui.selectedPeriod)).slice(0, 4);
  const recentIncomeEntries = sortDateDesc(getIncomeEntriesForPeriod(state.ui.selectedPeriod)).slice(0, 4);
  const duesSummary = getAllDueCounts(state.ui.selectedPeriod);
  const currentGroup = getCurrentGroup();
  const editingIncome = getIncomeEntries().find((entry) => entry.id === state.ui.editing.incomeId) || null;
  const isInstantGroup = currentGroup?.kind === "인스턴트모임";

  return `
    <section class="hero-panel">
      <article class="hero-card accent">
        <p class="eyebrow">Current month</p>
        <h3>${monthLabel(state.ui.selectedPeriod)} ${isInstantGroup ? "1회성 모임 정산" : "총무 운영 요약"}</h3>
        <p>${currentGroup?.name || "현재 모임"} 기준으로 입금, 이자, 지출, 월 마감만 빠르게 처리하면 됩니다.</p>
        <div class="quick-strip" style="margin-top:16px;">
          <button class="primary-button" type="button" data-action="select-tab" data-tab="deposits">입금</button>
          <button class="secondary-button" type="button" data-action="select-tab" data-tab="expenses">지출</button>
          <button class="ghost-button" type="button" data-action="select-tab" data-tab="closing">마감</button>
          ${isInstantGroup ? "" : `<button class="ghost-button" type="button" data-action="select-tab" data-tab="submeetings">소모임</button>`}
        </div>
        <div class="summary-strip" style="margin-top:16px;">
          <span class="status-badge status-paid">회비 입금 ${formatCurrency(snapshot.depositIncome)}</span>
          <span class="status-badge status-active">이자 ${formatCurrency(snapshot.interestIncome)}</span>
          <span class="status-badge status-exempt">지출 ${formatCurrency(snapshot.expense)}</span>
          <span class="status-badge ${closing ? "status-closed" : "status-review"}">${closing ? "마감 완료" : "진행 중"}</span>
        </div>
      </article>
      <article class="hero-card">
        <p class="eyebrow">Status</p>
        <h3>현재 잔액 ${formatCurrency(snapshot.closingBalance)}</h3>
        <div class="kpi-list">
          ${renderKpiRow("기초잔액", formatCurrency(snapshot.openingBalance))}
          ${renderKpiRow("회비 입금", formatCurrency(snapshot.depositIncome))}
          ${renderKpiRow("이자 수입", formatCurrency(snapshot.interestIncome))}
          ${renderKpiRow("지출", formatCurrency(snapshot.expense))}
          ${renderKpiRow("미납/부분", `${snapshot.unpaidCount}명`)}
          ${renderKpiRow("확인 필요 입금", `${snapshot.reviewCount}건`)}
        </div>
      </article>
    </section>

    <section class="metric-grid">
      <article class="metric-card success">
        <span>기초잔액</span>
        <strong>${formatCurrency(snapshot.openingBalance)}</strong>
      </article>
      <article class="metric-card ${snapshot.closingBalance < 0 ? "negative" : ""}">
        <span>현재 잔액</span>
        <strong>${formatCurrency(snapshot.closingBalance)}</strong>
      </article>
      <article class="metric-card">
        <span>회비 입금</span>
        <strong>${formatCurrency(snapshot.depositIncome)}</strong>
      </article>
      <article class="metric-card">
        <span>이자 수입</span>
        <strong>${formatCurrency(snapshot.interestIncome)}</strong>
      </article>
      <article class="metric-card">
        <span>지출</span>
        <strong>${formatCurrency(snapshot.expense)}</strong>
      </article>
      <article class="metric-card alert">
        <span>미납/부분 납부</span>
        <strong>${snapshot.unpaidCount}명</strong>
      </article>
      <article class="metric-card alert">
        <span>확인 필요 입금</span>
        <strong>${snapshot.reviewCount}건</strong>
      </article>
      <article class="metric-card">
        <span>마감 상태</span>
        <strong>${closing ? "마감 완료" : "진행 중"}</strong>
      </article>
    </section>

    <section class="section-grid">
      <div class="stack">
        <article class="data-table">
          <div class="section-title">
            <div>
              <h3>최근 입금</h3>
              <p>${monthLabel(state.ui.selectedPeriod)} 기준 최근 입금입니다.</p>
            </div>
            <button class="secondary-button" type="button" data-action="select-tab" data-tab="deposits">
              전체 보기
            </button>
          </div>
          ${renderDepositTable(recentDeposits, false)}
        </article>

        <article class="data-table">
          <div class="section-title">
            <div>
              <h3>최근 지출</h3>
              <p>${monthLabel(state.ui.selectedPeriod)} 기준 최근 지출입니다.</p>
            </div>
            <button class="secondary-button" type="button" data-action="select-tab" data-tab="expenses">
              지출 보기
            </button>
          </div>
          ${renderExpenseTable(recentExpenses, false)}
        </article>
      </div>

      <div class="stack">
        <article class="form-panel">
          <div class="section-title">
            <div>
              <h3>${editingIncome ? "이자 수정" : "이자 등록"}</h3>
              <p>통장 이자는 회비와 별도로 기록해 잔액에 반영합니다.</p>
            </div>
          </div>
          <form id="income-form">
            <input type="hidden" name="editingId" value="${editingIncome?.id || ""}" />
            <input type="hidden" name="type" value="이자" />
            <div class="form-grid">
              <label class="field-stack">
                <span>이자일</span>
                <input name="date" type="date" required value="${editingIncome?.date || today()}" />
              </label>
              <label class="field-stack">
                <span>이자 금액</span>
                <input name="amount" type="number" min="1" required value="${editingIncome?.amount || ""}" />
              </label>
            </div>
            <label class="field-stack" style="margin-top:14px;">
              <span>메모</span>
              <input name="note" value="${escapeHtml(editingIncome?.note || "")}" placeholder="예: 3월 통장 이자" />
            </label>
            <div class="form-actions">
              <button class="primary-button" type="submit">${editingIncome ? "이자 수정" : "이자 저장"}</button>
              <button class="ghost-button" type="button" data-action="clear-income-form">비우기</button>
            </div>
          </form>
        </article>

        <article class="data-table">
          <div class="section-title">
            <div>
              <h3>이달 이자 내역</h3>
              <p>${monthLabel(state.ui.selectedPeriod)} 기준으로만 보여줍니다.</p>
            </div>
          </div>
          ${renderIncomeEntryTable(recentIncomeEntries, true)}
        </article>

        <article class="card">
          <div class="section-title">
            <div>
              <h3>이번 월 납부 요약</h3>
              <p>한눈에 볼 값만 남겼습니다.</p>
            </div>
          </div>
          <div class="kpi-list">
            ${renderKpiRow("납부 완료", `${duesSummary.paidCount}명`)}
            ${renderKpiRow("부분 납부", `${duesSummary.partialCount}명`)}
            ${renderKpiRow("미납", `${duesSummary.unpaidOnlyCount}명`)}
            ${renderKpiRow("확인 필요", `${duesSummary.reviewAssignmentCount}명`)}
            ${renderKpiRow("면제", `${duesSummary.exemptCount}명`)}
          </div>
          <div class="quick-strip" style="margin-top:16px;">
            <button class="ghost-button" type="button" data-action="select-tab" data-tab="members">회원</button>
            <button class="ghost-button" type="button" data-action="select-tab" data-tab="dues">회비</button>
            <button class="ghost-button" type="button" data-action="select-tab" data-tab="history">이력</button>
          </div>
        </article>
      </div>
    </section>
  `;
}

function renderYearlyFinanceOverview() {
  const year = getSelectedYear();
  const monthRows = getYearMonthPeriods(year).map((item) => {
    const snapshot = getPeriodSnapshot(item.period);
    return {
      ...item,
      income: snapshot.income,
      expense: snapshot.expense,
      net: snapshot.income - snapshot.expense,
    };
  });
  const yearExpenses = sortDateDesc(getExpenses().filter((expense) => periodOf(expense.date).startsWith(year))).slice(
    0,
    6,
  );
  const totalIncome = monthRows.reduce((sum, item) => sum + item.income, 0);
  const totalExpense = monthRows.reduce((sum, item) => sum + item.expense, 0);

  return `
    <section class="section-grid annual-overview">
      <article class="data-table">
        <div class="section-title">
          <div>
            <h3>${year}년 월별 자금 흐름</h3>
            <p>입금과 지출을 한 해 기준으로 빠르게 훑을 수 있습니다.</p>
          </div>
        </div>
        <div class="year-month-grid">
          ${monthRows
            .map(
              (item) => `
                <article class="year-month-card ${item.period === state.ui.selectedPeriod ? "is-current" : ""}">
                  <header>
                    <strong>${item.label}</strong>
                    <span>${item.period === state.ui.selectedPeriod ? "선택 월" : "연간 보기"}</span>
                  </header>
                  <div class="month-value-row">
                    <span>입금</span>
                    <strong>${formatCurrency(item.income)}</strong>
                  </div>
                  <div class="month-value-row">
                    <span>지출</span>
                    <strong>${formatCurrency(item.expense)}</strong>
                  </div>
                  <div class="month-value-row">
                    <span>순증감</span>
                    <strong class="${item.net < 0 ? "negative-text" : ""}">${formatCurrency(item.net)}</strong>
                  </div>
                </article>
              `,
            )
            .join("")}
        </div>
      </article>

      <article class="card">
        <div class="section-title">
          <div>
            <h3>${year}년 사용 요약</h3>
            <p>연간 기준으로 얼마가 들어오고 어디에 썼는지 바로 확인합니다.</p>
          </div>
        </div>
        <div class="kpi-list">
          ${renderKpiRow("연간 총 입금", formatCurrency(totalIncome))}
          ${renderKpiRow("연간 총 지출", formatCurrency(totalExpense))}
          ${renderKpiRow("연간 순증감", formatCurrency(totalIncome - totalExpense))}
          ${renderKpiRow("최근 지출 건수", `${yearExpenses.length}건`)}
        </div>
        <div class="year-ledger-list">
          ${
            yearExpenses.length
              ? yearExpenses
                  .map(
                    (expense) => `
                      <div class="year-ledger-item">
                        <div>
                          <strong>${escapeHtml(expense.vendor)}</strong>
                          <div class="muted">${escapeHtml(expense.purpose || expense.category)}</div>
                        </div>
                        <div class="text-right">
                          <strong>${formatCurrency(expense.amount)}</strong>
                          <div class="muted">${formatDate(expense.date)}</div>
                        </div>
                      </div>
                    `,
                  )
                  .join("")
              : `<div class="empty-state">선택한 연도의 지출이 없습니다.</div>`
          }
        </div>
      </article>
    </section>
  `;
}

function renderAnnualMembershipBoard() {
  if (getCurrentGroup()?.kind === "인스턴트모임") {
    return `
      <section class="data-table annual-dues-board">
        <div class="section-title">
          <div>
            <h3>인스턴트모임 안내</h3>
            <p>인스턴트모임은 기존 정규모임과 완전히 분리된 독립 모임입니다. 연간 고정 회비판 대신 회원, 회비, 입금, 지출, 월 마감만 사용하면 됩니다.</p>
          </div>
          <div class="badge-row">
            <span class="soft-tag">완전 독립 모임</span>
            <span class="soft-tag">별도 멤버 구성 가능</span>
            <span class="soft-tag">1회성 회비/정산 가능</span>
          </div>
        </div>
      </section>
    `;
  }

  const year = getSelectedYear();
  const months = getYearMonthPeriods(year);
  const members = getMembers()
    .filter((member) => member.duesEligible)
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name, "ko-KR"));
  const rows = members.map((member) => {
    const cells = months.map((item) => getAnnualMembershipCell(member, item.period));
    return {
      member,
      cells,
      dueAmount: cells.reduce((sum, cell) => sum + cell.dueAmount, 0),
      paidAmount: cells.reduce((sum, cell) => sum + cell.paidAmount, 0),
    };
  });
  const footerPaid = months.map((_, index) =>
    rows.reduce((sum, row) => sum + row.cells[index].paidAmount, 0),
  );
  const footerDue = months.map((_, index) => rows.reduce((sum, row) => sum + row.cells[index].dueAmount, 0));

  return `
    <section class="data-table annual-dues-board">
      <div class="section-title">
        <div>
          <h3>${year}년 고정 회비 연간 현황</h3>
          <p>월회비만 연간 표로 묶고, 각 칸에는 납부 상태와 마지막 입금일을 같이 표시합니다.</p>
        </div>
        <div class="badge-row">
          <span class="status-badge status-paid">완납</span>
          <span class="status-badge status-partial">부분</span>
          <span class="status-badge status-unpaid">미납</span>
          <span class="status-badge status-review">검토</span>
          <span class="soft-tag">가입 전 = 의무 없음</span>
          <span class="soft-tag">미생성 = 해당 월 회비 미등록</span>
        </div>
      </div>

      ${
        rows.length
          ? `
            <div class="table-wrap annual-table-wrap">
              <table class="annual-dues-table">
                <thead>
                  <tr>
                    <th>회원</th>
                    <th>가입일</th>
                    ${months.map((item) => `<th>${item.label}</th>`).join("")}
                    <th class="text-right">연간 납부/의무</th>
                  </tr>
                </thead>
                <tbody>
                  ${rows
                    .map(
                      (row) => `
                        <tr>
                          <td>
                            <strong>${escapeHtml(row.member.name)}</strong>
                            <div class="muted">${escapeHtml(row.member.payerName || row.member.nickname || "-")}</div>
                          </td>
                          <td>${escapeHtml(row.member.joinDate || "-")}</td>
                          ${row.cells.map((cell) => renderAnnualMembershipCell(cell)).join("")}
                          <td class="text-right">
                            <strong>${formatCurrency(row.paidAmount)}</strong>
                            <div class="muted">의무 ${formatCurrency(row.dueAmount)}</div>
                          </td>
                        </tr>
                      `,
                    )
                    .join("")}
                </tbody>
                <tfoot>
                  <tr>
                    <th colspan="2">월 합계</th>
                    ${months
                      .map(
                        (_, index) => `
                          <th>
                            <div>${formatCurrency(footerPaid[index])}</div>
                            <div class="muted">의무 ${formatCurrency(footerDue[index])}</div>
                          </th>
                        `,
                      )
                      .join("")}
                    <th class="text-right">
                      <div>${formatCurrency(footerPaid.reduce((sum, value) => sum + value, 0))}</div>
                      <div class="muted">의무 ${formatCurrency(footerDue.reduce((sum, value) => sum + value, 0))}</div>
                    </th>
                  </tr>
                </tfoot>
              </table>
            </div>
          `
          : `<div class="empty-state">회비 대상 회원이 없습니다. 회원 화면에서 가입일과 회비 대상을 먼저 등록하세요.</div>`
      }
    </section>
  `;
}

function renderAnnualMembershipCell(cell) {
  return `
    <td title="${escapeHtml(cell.title)}">
      <div class="year-status-card status-${cell.code}">
        <strong>${escapeHtml(cell.label)}</strong>
        <span>${escapeHtml(cell.detail || "-")}</span>
      </div>
    </td>
  `;
}

function renderMembers() {
  const filters = state.ui.filters;
  const editingMember = getMember(state.ui.editing.memberId);
  const rows = filterMembers(filters);

  return `
    <section class="section-grid">
      <div class="stack">
        <article class="data-table">
          <div class="section-title">
            <div>
              <h3>회원 목록</h3>
              <p>회비 대상과 입금자명 메모를 같이 관리합니다.</p>
            </div>
            <div class="inline-actions">
              <button class="secondary-button" type="button" data-action="new-member">새 회원</button>
            </div>
          </div>
          <div class="filter-strip">
            <label class="inline-field">
              <span>검색</span>
              <input
                type="search"
                data-filter-key="memberQuery"
                value="${escapeHtml(filters.memberQuery)}"
                placeholder="이름, 닉네임, 입금자명"
              />
            </label>
            <label class="inline-field">
              <span>상태</span>
              <select data-filter-key="memberStatus">
                ${renderOptions(
                  [
                    { value: "all", label: "전체" },
                    { value: "활성", label: "활성" },
                    { value: "비활성", label: "비활성" },
                  ],
                  filters.memberStatus,
                )}
              </select>
            </label>
            <label class="inline-field">
              <span>회비 대상</span>
              <select data-filter-key="memberEligibility">
                ${renderOptions(
                  [
                    { value: "all", label: "전체" },
                    { value: "yes", label: "대상만" },
                    { value: "no", label: "비대상만" },
                  ],
                  filters.memberEligibility,
                )}
              </select>
            </label>
          </div>
          ${renderMemberTable(rows)}
        </article>
      </div>

      <aside class="form-panel">
        <div class="section-title">
          <div>
            <h3>${editingMember ? "회원 수정" : "회원 등록"}</h3>
            <p>${editingMember ? "입금자명과 회비 대상 여부를 같이 관리합니다." : "신규 회원을 등록합니다."}</p>
          </div>
        </div>
        <form id="member-form">
          <input type="hidden" name="editingId" value="${editingMember ? editingMember.id : ""}" />
          <div class="form-grid">
            <label class="field-stack">
              <span>이름</span>
              <input name="name" required value="${escapeHtml(editingMember?.name || "")}" />
            </label>
            <label class="field-stack">
              <span>닉네임</span>
              <input name="nickname" value="${escapeHtml(editingMember?.nickname || "")}" />
            </label>
            <label class="field-stack">
              <span>연락처</span>
              <input name="contact" value="${escapeHtml(editingMember?.contact || "")}" />
            </label>
            <label class="field-stack">
              <span>가입일</span>
              <input name="joinDate" type="date" value="${editingMember?.joinDate || ""}" />
            </label>
            <label class="field-stack">
              <span>입금자명</span>
              <input name="payerName" value="${escapeHtml(editingMember?.payerName || "")}" />
            </label>
            <label class="field-stack">
              <span>상태</span>
              <select name="status">
                ${renderOptions(
                  [
                    { value: "활성", label: "활성" },
                    { value: "비활성", label: "비활성" },
                  ],
                  editingMember?.status || "활성",
                )}
              </select>
            </label>
            <label class="field-stack">
              <span>메모</span>
              <input name="memo" value="${escapeHtml(editingMember?.memo || "")}" />
            </label>
          </div>
          <label class="checkbox-row" style="margin-top:14px;">
            <input
              type="checkbox"
              name="duesEligible"
              ${editingMember ? (editingMember.duesEligible ? "checked" : "") : "checked"}
            />
            <span>회비 대상 회원으로 관리</span>
          </label>
          <div class="form-actions">
            <button class="primary-button" type="submit">${editingMember ? "회원 수정" : "회원 등록"}</button>
            <button class="ghost-button" type="button" data-action="clear-member-form">초기화</button>
          </div>
        </form>
      </aside>
    </section>
  `;
}

function renderDues() {
  const dues = getDuesForPeriod(state.ui.selectedPeriod);
  const editingDue = getDue(state.ui.editing.dueId);
  const selectedDue = getDue(state.ui.selectedDueId);
  const assignments = filterAssignmentsForSelectedDue(selectedDue?.id);
  const dueSummary = selectedDue ? getDueCounts(selectedDue.id) : null;
  const eligibleMembers = getMembers().filter(isEligibleMember);

  return `
    ${renderAnnualMembershipBoard()}

    <section class="section-grid dues-workspace">
      <div class="stack">
        <article class="list-panel">
          <div class="section-title">
            <div>
              <h3>${monthLabel(state.ui.selectedPeriod)} 회비 항목</h3>
              <p>현재 월 기준 회비와 행사비를 관리합니다.</p>
            </div>
            <button class="secondary-button" type="button" data-action="new-due">새 회비</button>
          </div>
          ${
            dues.length
              ? `<div class="dues-card-list">${dues.map(renderDueCard).join("")}</div>`
              : `<div class="empty-state">선택한 월에 등록된 회비 항목이 없습니다.</div>`
          }
        </article>

        <article class="data-table">
          <div class="section-title">
            <div>
              <h3>${selectedDue ? escapeHtml(selectedDue.title) : "납부 현황"}</h3>
              <p>${selectedDue ? `${selectedDue.type} · ${formatCurrency(selectedDue.amount)} · 마감 ${formatDate(selectedDue.dueDate)}` : "회비 항목을 선택하세요."}</p>
            </div>
            ${
              dueSummary
                ? `<div class="badge-row">
                    <span class="status-badge status-paid">완납 ${dueSummary.paidCount}</span>
                    <span class="status-badge status-partial">부분 ${dueSummary.partialCount}</span>
                    <span class="status-badge status-unpaid">미납 ${dueSummary.unpaidOnlyCount}</span>
                    <span class="status-badge status-review">검토 ${dueSummary.reviewCount}</span>
                  </div>`
                : ""
            }
          </div>
          ${
            selectedDue
              ? `
                <div class="filter-strip">
                  <label class="inline-field">
                    <span>상태 필터</span>
                    <select data-filter-key="dueAssignmentStatus">
                      ${renderOptions(
                        [
                          { value: "all", label: "전체" },
                          { value: "미납", label: "미납" },
                          { value: "납부 완료", label: "납부 완료" },
                          { value: "부분 납부", label: "부분 납부" },
                          { value: "확인 필요", label: "확인 필요" },
                          { value: "면제", label: "면제" },
                        ],
                        state.ui.filters.dueAssignmentStatus,
                      )}
                    </select>
                  </label>
                </div>
                ${renderAssignmentTable(assignments, selectedDue)}
              `
              : `<div class="empty-state">왼쪽에서 회비 항목을 선택하면 납부 현황이 나타납니다.</div>`
          }
        </article>
      </div>

      <aside class="form-panel">
        <div class="section-title">
          <div>
            <h3>${editingDue ? "회비 수정" : "회비 생성"}</h3>
            <p>${editingDue ? "기존 회비는 금액, 마감일, 설명 위주로 수정합니다." : "새로운 회비 항목을 만듭니다."}</p>
          </div>
        </div>
        <form id="due-form">
          <input type="hidden" name="editingId" value="${editingDue ? editingDue.id : ""}" />
          <div class="form-grid">
            <label class="field-stack">
              <span>회비명</span>
              <input name="title" required value="${escapeHtml(editingDue?.title || "")}" />
            </label>
            <label class="field-stack">
              <span>구분</span>
              <select name="type">
                ${renderOptions(
                  [
                    { value: "월회비", label: "월회비" },
                    { value: "분기회비", label: "분기회비" },
                    { value: "행사비", label: "행사비" },
                  ],
                  editingDue?.type || "월회비",
                )}
              </select>
            </label>
            <label class="field-stack">
              <span>금액</span>
              <input name="amount" type="number" min="1" required value="${editingDue ? editingDue.amount : ""}" />
            </label>
            <label class="field-stack">
              <span>대상 월</span>
              ${
                editingDue
                  ? `<input value="${editingDue.period}" disabled />`
                  : `<input name="period" type="month" value="${state.ui.selectedPeriod}" required />`
              }
            </label>
            <label class="field-stack">
              <span>마감일</span>
              <input name="dueDate" type="date" value="${editingDue?.dueDate || dateInPeriod(state.ui.selectedPeriod, 20)}" required />
            </label>
            <label class="field-stack">
              <span>대상 방식</span>
              ${
                editingDue
                  ? `<input value="기존 대상 유지" disabled />`
                  : `<select name="targetMode">
                      ${renderOptions(
                        [
                          { value: "all", label: "활성 회비 대상 전체" },
                          { value: "selected", label: "선택 회원만" },
                        ],
                        "all",
                      )}
                    </select>`
              }
            </label>
          </div>
          ${
            editingDue
              ? `<p class="helper-text" style="margin-top:12px;">수정 모드에서는 대상 회원은 그대로 유지합니다. 대상 변경은 새 회비로 분리하는 편이 안전합니다.</p>`
              : `
                <label class="field-stack" style="margin-top:14px;">
                  <span>선택 회원</span>
                  <select name="targetMemberIds" multiple size="6">
                    ${eligibleMembers
                      .map(
                        (member) => `
                          <option value="${member.id}">
                            ${escapeHtml(member.name)} · ${escapeHtml(member.payerName || member.nickname || "")}
                          </option>
                        `,
                      )
                      .join("")}
                  </select>
                </label>
              `
          }
          <label class="field-stack" style="margin-top:14px;">
            <span>설명</span>
            <textarea name="note">${escapeHtml(editingDue?.note || "")}</textarea>
          </label>
          <div class="form-actions">
            <button class="primary-button" type="submit">${editingDue ? "회비 수정" : "회비 생성"}</button>
            <button class="ghost-button" type="button" data-action="clear-due-form">초기화</button>
          </div>
        </form>
      </aside>
    </section>
  `;
}

function renderDeposits() {
  const editingDeposit = getDeposit(state.ui.editing.depositId);
  const draft = editingDeposit || state.ui.depositDraft;
  const deposits = sortDateDesc(getDepositsForPeriod(state.ui.selectedPeriod));
  const selectedMember = getMember(draft.memberId);
  const dueOptions = getDepositDueOptions(draft.memberId);
  const selectedDue = getDue(draft.dueId);
  const suggestedAmount = editingDeposit ? editingDeposit.amount : selectedDue?.amount || "";
  const suggestedPayerName = editingDeposit?.payerName || selectedMember?.payerName || selectedMember?.name || "";
  const currentSnapshot = getPeriodSnapshot(state.ui.selectedPeriod);
  const currentGroup = getCurrentGroup();
  const quickAmounts = unique(
    [selectedDue?.amount || 0, currentGroup?.regularMonthlyFee || 0].filter((amount) => amount > 0),
  );

  return `
    <section class="stack">
      <article class="card">
        <div class="section-title">
          <div>
            <h3>${monthLabel(state.ui.selectedPeriod)} 입금</h3>
            <p>회원 선택, 회비 선택, 저장 순서로만 처리합니다.</p>
          </div>
          <div class="badge-row">
            <span class="status-badge status-paid">회비 입금 ${formatCurrency(currentSnapshot.depositIncome)}</span>
            <span class="status-badge status-review">확인 필요 ${currentSnapshot.reviewCount}건</span>
            <span class="soft-tag">총 ${deposits.length}건</span>
          </div>
        </div>
      </article>

      <article class="form-panel">
        <div class="section-title">
          <div>
            <h3>${editingDeposit ? "입금 수정" : "입금 등록"}</h3>
            <p>회비를 고르면 금액이 자동으로 채워지고, 아래 버튼으로 고정 회비 금액도 바로 넣을 수 있습니다.</p>
          </div>
        </div>
        <form id="deposit-form">
          <input type="hidden" name="editingId" value="${editingDeposit ? editingDeposit.id : ""}" />
          <div class="form-grid">
            <label class="field-stack">
              <span>회원</span>
              <select name="memberId">
                <option value="">미지정 입금</option>
                ${getMembers()
                  .filter((member) => member.status === "활성")
                  .map(
                    (member) => `
                      <option value="${member.id}" ${draft.memberId === member.id ? "selected" : ""}>
                        ${escapeHtml(member.name)} · ${escapeHtml(member.payerName || member.nickname || "")}
                      </option>
                    `,
                  )
                  .join("")}
              </select>
            </label>
            <label class="field-stack">
              <span>회비 항목</span>
              <select name="dueId">
                <option value="">미지정</option>
                ${dueOptions
                  .map(
                    (due) => `
                      <option value="${due.id}" ${draft.dueId === due.id ? "selected" : ""}>
                        ${escapeHtml(`${due.period} · ${due.title}`)} · ${formatCurrency(due.amount)}
                      </option>
                    `,
                  )
                  .join("")}
              </select>
              <span class="helper-text">회비를 선택하면 정해진 금액이 바로 들어갑니다.</span>
            </label>
            <label class="field-stack">
              <span>입금일</span>
              <input name="date" type="date" required value="${editingDeposit?.date || today()}" />
            </label>
            <label class="field-stack">
              <span>입금 금액</span>
              <input name="amount" type="number" min="1" required value="${suggestedAmount}" />
            </label>
            <label class="field-stack">
              <span>입금자명</span>
              <input name="payerName" value="${escapeHtml(suggestedPayerName)}" />
            </label>
            <label class="field-stack">
              <span>상태</span>
              <select name="statusChoice">
                ${renderOptions(
                  [
                    { value: "납부 완료", label: "납부 완료" },
                    { value: "부분 납부", label: "부분 납부" },
                    { value: "확인 필요", label: "확인 필요" },
                  ],
                  draft.status || "납부 완료",
                )}
              </select>
              <span class="helper-text">입금 확인이 끝난 건은 납부 완료, 미확정 건만 확인 필요로 두면 됩니다.</span>
            </label>
          </div>
          ${
            quickAmounts.length
              ? `
                <div class="quick-strip" style="margin-top:14px;">
                  ${quickAmounts
                    .map(
                      (amount) => `
                        <button class="ghost-button" type="button" data-action="set-deposit-amount" data-amount="${amount}">
                          ${formatCurrency(amount)}
                        </button>
                      `,
                    )
                    .join("")}
                </div>
              `
              : ""
          }
          <label class="field-stack" style="margin-top:14px;">
            <span>메모</span>
            <textarea name="memo">${escapeHtml(editingDeposit?.memo || "")}</textarea>
          </label>
          <div class="form-actions">
            <button class="primary-button" type="submit">${editingDeposit ? "수정 저장" : "입금 저장"}</button>
            <button class="ghost-button" type="button" data-action="clear-deposit-form">비우기</button>
          </div>
        </form>
      </article>

      <article class="data-table">
        <div class="section-title">
          <div>
            <h3>${monthLabel(state.ui.selectedPeriod)} 입금 내역</h3>
            <p>선택한 월의 입금만 보여줍니다.</p>
          </div>
          <button class="secondary-button" type="button" data-action="new-deposit">새로 입력</button>
        </div>
        ${renderDepositTable(deposits, true)}
      </article>
    </section>
  `;
}

function renderExpenses() {
  const editingExpense = getExpense(state.ui.editing.expenseId);
  const expenses = sortDateDesc(getExpensesForPeriod(state.ui.selectedPeriod));
  const activeCategories = getActiveCategories();
  const currentSnapshot = getPeriodSnapshot(state.ui.selectedPeriod);

  return `
    <section class="stack">
      <article class="card">
        <div class="section-title">
          <div>
            <h3>${monthLabel(state.ui.selectedPeriod)} 지출</h3>
            <p>쓴 즉시 금액과 사용처만 먼저 넣고, 증빙은 파일명으로만 남깁니다.</p>
          </div>
          <div class="badge-row">
            <span class="status-badge status-exempt">지출 ${formatCurrency(currentSnapshot.expense)}</span>
            <span class="soft-tag">총 ${expenses.length}건</span>
          </div>
        </div>
      </article>

      <article class="form-panel">
        <div class="section-title">
          <div>
            <h3>${editingExpense ? "지출 수정" : "지출 등록"}</h3>
            <p>이 데모에서는 첨부 파일 자체 대신 파일명만 저장합니다.</p>
          </div>
        </div>
        <form id="expense-form">
          <input type="hidden" name="editingId" value="${editingExpense ? editingExpense.id : ""}" />
          <div class="form-grid">
            <label class="field-stack">
              <span>지출일</span>
              <input name="date" type="date" required value="${editingExpense?.date || today()}" />
            </label>
            <label class="field-stack">
              <span>금액</span>
              <input name="amount" type="number" min="1" required value="${editingExpense ? editingExpense.amount : ""}" />
            </label>
            <label class="field-stack">
              <span>카테고리</span>
              <select name="category">
                ${renderOptions(
                  activeCategories.map((category) => ({
                    value: category.name,
                    label: category.name,
                  })),
                  editingExpense?.category || activeCategories[0]?.name || "기타",
                )}
              </select>
            </label>
            <label class="field-stack">
              <span>사용처</span>
              <input name="vendor" required value="${escapeHtml(editingExpense?.vendor || "")}" />
            </label>
            <label class="field-stack">
              <span>행사/목적</span>
              <input name="purpose" value="${escapeHtml(editingExpense?.purpose || "")}" />
            </label>
            <label class="field-stack">
              <span>영수증 파일</span>
              <input name="receiptFile" type="file" accept=".jpg,.jpeg,.png,.pdf" />
            </label>
          </div>
          ${
            editingExpense?.receiptName
              ? `<p class="helper-text" style="margin-top:12px;">현재 저장된 파일명: ${escapeHtml(editingExpense.receiptName)}</p>`
              : ""
          }
          <label class="field-stack" style="margin-top:14px;">
            <span>메모</span>
            <textarea name="memo">${escapeHtml(editingExpense?.memo || "")}</textarea>
          </label>
          <div class="form-actions">
            <button class="primary-button" type="submit">${editingExpense ? "수정 저장" : "지출 저장"}</button>
            <button class="ghost-button" type="button" data-action="clear-expense-form">비우기</button>
          </div>
        </form>
      </article>

      <article class="data-table">
        <div class="section-title">
          <div>
            <h3>${monthLabel(state.ui.selectedPeriod)} 지출 내역</h3>
            <p>선택한 월의 지출만 보여줍니다.</p>
          </div>
          <button class="secondary-button" type="button" data-action="new-expense">새로 입력</button>
        </div>
        ${renderExpenseTable(expenses, true)}
      </article>
    </section>
  `;
}

function renderSubmeetings() {
  if (getCurrentGroup()?.kind === "인스턴트모임") {
    return `
      <section class="hero-panel">
        <article class="hero-card accent">
          <p class="eyebrow">Instant meeting</p>
          <h3>이 모임은 이미 독립된 1회성 모임입니다.</h3>
          <p>
            인스턴트모임은 기존 정규모임의 소모임 기능을 쓰지 않아도 됩니다.
            회원, 회비, 입금, 지출, 월 마감 화면만으로 완전히 별개 정산을 진행하세요.
          </p>
          <div class="quick-strip" style="margin-top:16px;">
            <button class="primary-button" type="button" data-action="select-tab" data-tab="members">회원 관리</button>
            <button class="secondary-button" type="button" data-action="select-tab" data-tab="dues">회비 관리</button>
            <button class="secondary-button" type="button" data-action="select-tab" data-tab="expenses">지출 관리</button>
          </div>
        </article>
        <article class="hero-card">
          <p class="eyebrow">Why</p>
          <h3>완전 별도 멤버 모임용</h3>
          <ul class="hero-list">
            <li>정규모임과 전혀 다른 인원을 넣을 수 있습니다.</li>
            <li>1회성 회비 징수와 지출 정산만 하고 끝낼 수 있습니다.</li>
            <li>필요 없으면 설정 화면에서 모임 자체를 삭제하면 됩니다.</li>
          </ul>
        </article>
      </section>
    `;
  }

  const meetings = getTempMeetings()
    .slice()
    .sort((left, right) => `${right.date}${right.createdAt}`.localeCompare(`${left.date}${left.createdAt}`));
  const selectedMeeting = getSelectedTempMeeting();
  const settlementRows = selectedMeeting ? buildTempMeetingSettlement(selectedMeeting) : [];
  const meetingExpenses = selectedMeeting
    ? getTempMeetingExpenses(selectedMeeting.id).slice().sort((left, right) => right.date.localeCompare(left.date))
    : [];
  const meetingPayments = selectedMeeting
    ? getTempMeetingPayments(selectedMeeting.id).slice().sort((left, right) => right.date.localeCompare(left.date))
    : [];
  const meetingAdjustments = selectedMeeting
    ? getTempMeetingAdjustments(selectedMeeting.id).slice().sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    : [];
  const activeMembers = getMembers().filter((member) => member.status === "활성");
  const selectedParticipantIds = selectedMeeting?.participantIds || [];
  const participantMembers = selectedParticipantIds
    .map((memberId) => getMember(memberId))
    .filter(Boolean);
  const expenseTotal = meetingExpenses.reduce((sum, expense) => sum + asNumber(expense.amount), 0);
  const paymentTotal = meetingPayments.reduce((sum, payment) => sum + asNumber(payment.amount), 0);
  const balanceTotal = settlementRows.reduce((sum, row) => sum + row.balance, 0);
  const isLocked = selectedMeeting?.status === "반영 완료";

  return `
    <section class="hero-panel">
      <article class="hero-card accent">
        <p class="eyebrow">Sub-meeting</p>
        <h3>임시모임 정산</h3>
        <p>
          정규 모임 안에서 번개, 뒤풀이, 소모임을 별도로 정산합니다.
          지출에 참여 인원을 지정하면 인당 부담액이 계산되고, 예외 금액은 별도로 조정할 수 있습니다.
        </p>
        <div class="summary-strip" style="margin-top:16px;">
          <span class="status-badge status-active">진행 중 ${meetings.filter((meeting) => meeting.status !== "반영 완료").length}개</span>
          <span class="status-badge status-paid">총 지출 ${formatCurrency(expenseTotal)}</span>
          <span class="status-badge status-partial">총 납부 ${formatCurrency(paymentTotal)}</span>
          <span class="status-badge ${balanceTotal > 0 ? "status-review" : "status-closed"}">미정산 ${formatCurrency(balanceTotal)}</span>
        </div>
      </article>
      <article class="hero-card">
        <p class="eyebrow">Selected</p>
        <h3>${selectedMeeting ? escapeHtml(selectedMeeting.name) : "선택된 임시모임 없음"}</h3>
        <ul class="hero-list">
          <li>일자: ${selectedMeeting ? formatDate(selectedMeeting.date) : "-"}</li>
          <li>참여 인원: ${participantMembers.length}명</li>
          <li>상태: ${selectedMeeting ? selectedMeeting.status : "-"}</li>
          <li>정규모임 반영: ${selectedMeeting?.reflectedAt ? formatDateTime(selectedMeeting.reflectedAt) : "아직 안 함"}</li>
        </ul>
      </article>
    </section>

    <section class="section-grid">
      <div class="stack">
        <article class="list-panel">
          <div class="section-title">
            <div>
              <h3>임시모임 목록</h3>
              <p>현재 모임 안에서 별도 정산 중인 소모임 목록입니다.</p>
            </div>
          </div>
          ${
            meetings.length
              ? `<div class="dues-card-list">${meetings.map(renderTempMeetingCard).join("")}</div>`
              : `<div class="empty-state">등록된 임시모임이 없습니다. 오른쪽에서 새 임시모임을 추가하세요.</div>`
          }
        </article>

        <article class="data-table">
          <div class="section-title">
            <div>
              <h3>${selectedMeeting ? `${escapeHtml(selectedMeeting.name)} 정산표` : "정산표"}</h3>
              <p>참여 인원별 부담액, 예외 조정, 실제 납부액을 같이 봅니다.</p>
            </div>
          </div>
          ${selectedMeeting ? renderTempMeetingSettlementTable(settlementRows) : `<div class="empty-state">임시모임을 선택하면 정산표가 보입니다.</div>`}
        </article>

        <article class="data-table">
          <div class="section-title">
            <div>
              <h3>소모임 지출</h3>
              <p>지출마다 적용 인원을 선택하면 인당 부담액이 자동으로 나뉩니다.</p>
            </div>
          </div>
          ${selectedMeeting ? renderTempMeetingExpenseTable(meetingExpenses) : `<div class="empty-state">선택된 임시모임이 없습니다.</div>`}
        </article>

        <article class="split-line submeeting-ledgers">
          <article class="data-table">
            <div class="section-title">
              <div>
                <h3>소모임 납부</h3>
                <p>각 참여자가 실제로 낸 금액입니다.</p>
              </div>
            </div>
            ${selectedMeeting ? renderTempMeetingPaymentTable(meetingPayments) : `<div class="empty-state">선택된 임시모임이 없습니다.</div>`}
          </article>

          <article class="data-table">
            <div class="section-title">
              <div>
                <h3>예외 조정</h3>
                <p>할인, 면제, 추가 부담 등 예외 금액을 반영합니다.</p>
              </div>
            </div>
            ${selectedMeeting ? renderTempMeetingAdjustmentTable(meetingAdjustments) : `<div class="empty-state">선택된 임시모임이 없습니다.</div>`}
          </article>
        </article>
      </div>

      <aside class="stack">
        <article class="form-panel">
          <div class="section-title">
            <div>
              <h3>임시모임 추가</h3>
              <p>정규모임 안에서 별도 정산이 필요한 소모임을 등록합니다.</p>
            </div>
          </div>
          <form id="temp-meeting-form">
            <div class="form-grid single">
              <label class="field-stack">
                <span>임시모임 이름</span>
                <input name="name" required placeholder="예: 뒤풀이, 번개모임" />
              </label>
              <label class="field-stack">
                <span>일자</span>
                <input name="date" type="date" value="${today()}" required />
              </label>
              <label class="field-stack">
                <span>참여 인원</span>
                <select name="participantIds" multiple size="8" required>
                  ${activeMembers
                    .map(
                      (member) => `
                        <option value="${member.id}">
                          ${escapeHtml(member.name)} · ${escapeHtml(member.payerName || member.nickname || "-")}
                        </option>
                      `,
                    )
                    .join("")}
                </select>
              </label>
              <label class="field-stack">
                <span>메모</span>
                <textarea name="note" placeholder="예: 식사비는 참석자끼리만 정산"></textarea>
              </label>
            </div>
            <div class="form-actions">
              <button class="primary-button" type="submit">임시모임 추가</button>
            </div>
          </form>
        </article>

        <article class="form-panel">
          <div class="section-title">
            <div>
              <h3>소모임 지출 추가</h3>
              <p>${selectedMeeting ? "지출별 적용 인원을 선택해 분배합니다." : "먼저 임시모임을 선택하세요."}</p>
            </div>
          </div>
          ${
            selectedMeeting
              ? `
                <form id="temp-expense-form">
                  <input type="hidden" name="tempMeetingId" value="${selectedMeeting.id}" />
                  <div class="form-grid">
                    <label class="field-stack">
                      <span>지출일</span>
                      <input name="date" type="date" value="${selectedMeeting.date}" ${isLocked ? "disabled" : ""} required />
                    </label>
                    <label class="field-stack">
                      <span>금액</span>
                      <input name="amount" type="number" min="1" ${isLocked ? "disabled" : ""} required />
                    </label>
                    <label class="field-stack">
                      <span>카테고리</span>
                      <select name="category" ${isLocked ? "disabled" : ""}>
                        ${renderOptions(
                          getActiveCategories().map((category) => ({
                            value: category.name,
                            label: category.name,
                          })),
                          getActiveCategories()[0]?.name || "기타",
                        )}
                      </select>
                    </label>
                    <label class="field-stack">
                      <span>사용처</span>
                      <input name="vendor" ${isLocked ? "disabled" : ""} required />
                    </label>
                    <label class="field-stack">
                      <span>목적</span>
                      <input name="purpose" ${isLocked ? "disabled" : ""} />
                    </label>
                    <label class="field-stack">
                      <span>적용 인원</span>
                      <select name="participantIds" multiple size="6" ${isLocked ? "disabled" : ""} required>
                        ${participantMembers
                          .map(
                            (member) => `
                              <option value="${member.id}" selected>
                                ${escapeHtml(member.name)}
                              </option>
                            `,
                          )
                          .join("")}
                      </select>
                    </label>
                  </div>
                  <label class="field-stack" style="margin-top:14px;">
                    <span>메모</span>
                    <textarea name="memo" ${isLocked ? "disabled" : ""}></textarea>
                  </label>
                  <div class="form-actions">
                    <button class="primary-button" type="submit" ${isLocked ? "disabled" : ""}>지출 추가</button>
                  </div>
                </form>
              `
              : `<div class="empty-state">임시모임을 먼저 선택하세요.</div>`
          }
        </article>

        <article class="form-panel">
          <div class="section-title">
            <div>
              <h3>소모임 납부 등록</h3>
              <p>${selectedMeeting ? "참여자의 납부 내역을 입력합니다." : "먼저 임시모임을 선택하세요."}</p>
            </div>
          </div>
          ${
            selectedMeeting
              ? `
                <form id="temp-payment-form">
                  <input type="hidden" name="tempMeetingId" value="${selectedMeeting.id}" />
                  <div class="form-grid">
                    <label class="field-stack">
                      <span>회원</span>
                      <select name="memberId" ${isLocked ? "disabled" : ""} required>
                        ${renderOptions(
                          participantMembers.map((member) => ({
                            value: member.id,
                            label: member.name,
                          })),
                          participantMembers[0]?.id || "",
                        )}
                      </select>
                    </label>
                    <label class="field-stack">
                      <span>납부일</span>
                      <input name="date" type="date" value="${today()}" ${isLocked ? "disabled" : ""} required />
                    </label>
                    <label class="field-stack">
                      <span>금액</span>
                      <input name="amount" type="number" min="1" ${isLocked ? "disabled" : ""} required />
                    </label>
                    <label class="field-stack">
                      <span>메모</span>
                      <input name="note" ${isLocked ? "disabled" : ""} />
                    </label>
                  </div>
                  <div class="form-actions">
                    <button class="primary-button" type="submit" ${isLocked ? "disabled" : ""}>납부 등록</button>
                  </div>
                </form>
              `
              : `<div class="empty-state">임시모임을 먼저 선택하세요.</div>`
          }
        </article>

        <article class="form-panel">
          <div class="section-title">
            <div>
              <h3>예외 금액 조정</h3>
              <p>${selectedMeeting ? "할인이나 추가 부담을 금액으로 직접 반영합니다." : "먼저 임시모임을 선택하세요."}</p>
            </div>
          </div>
          ${
            selectedMeeting
              ? `
                <form id="temp-adjustment-form">
                  <input type="hidden" name="tempMeetingId" value="${selectedMeeting.id}" />
                  <div class="form-grid">
                    <label class="field-stack">
                      <span>회원</span>
                      <select name="memberId" ${isLocked ? "disabled" : ""} required>
                        ${renderOptions(
                          participantMembers.map((member) => ({
                            value: member.id,
                            label: member.name,
                          })),
                          participantMembers[0]?.id || "",
                        )}
                      </select>
                    </label>
                    <label class="field-stack">
                      <span>조정 금액</span>
                      <input name="amount" type="number" step="1" ${isLocked ? "disabled" : ""} required />
                    </label>
                  </div>
                  <label class="field-stack" style="margin-top:14px;">
                    <span>사유</span>
                    <input name="reason" ${isLocked ? "disabled" : ""} required placeholder="예: 식사 미참여, 추가 주문" />
                  </label>
                  <p class="helper-text" style="margin-top:12px;">음수는 부담액 차감, 양수는 추가 부담입니다.</p>
                  <div class="form-actions">
                    <button class="primary-button" type="submit" ${isLocked ? "disabled" : ""}>예외 반영</button>
                  </div>
                </form>
              `
              : `<div class="empty-state">임시모임을 먼저 선택하세요.</div>`
          }
        </article>
      </aside>
    </section>
  `;
}

function renderClosing() {
  const snapshot = getPeriodSnapshot(state.ui.selectedPeriod);
  const closing = getClosingRecord(state.ui.selectedPeriod);
  const recentClosings = getClosings()
    .slice()
    .sort((left, right) => (right.closedAt || "").localeCompare(left.closedAt || ""));
  const ledgerRows = mergeLedgerRows(state.ui.selectedPeriod);

  return `
    <section class="hero-panel">
      <article class="hero-card accent">
        <p class="eyebrow">Closing</p>
        <h3>${monthLabel(state.ui.selectedPeriod)} 정산과 월 마감</h3>
        <p>
          기초잔액, 확정 수입, 지출을 기준으로 기말잔액을 계산하고 해당 월을 잠글 수 있습니다.
          재오픈은 명시적으로만 허용합니다.
        </p>
        <div class="summary-strip" style="margin-top:16px;">
          <span class="status-badge status-active">기초잔액 ${formatCurrency(snapshot.openingBalance)}</span>
          <span class="status-badge status-paid">회비 ${formatCurrency(snapshot.depositIncome)}</span>
          <span class="status-badge status-active">이자 ${formatCurrency(snapshot.interestIncome)}</span>
          <span class="status-badge status-exempt">지출 ${formatCurrency(snapshot.expense)}</span>
          <span class="status-badge ${closing ? "status-closed" : "status-review"}">
            ${closing ? "마감 완료" : "진행 중"}
          </span>
        </div>
      </article>
      <article class="hero-card">
        <p class="eyebrow">Result</p>
        <h3>기말잔액 ${formatCurrency(snapshot.closingBalance)}</h3>
        <p>
          다음 월의 기초잔액은 가장 최근 마감된 월의 기말잔액을 기본값으로 사용합니다.
        </p>
        <div class="form-actions" style="margin-top:16px;">
          ${
            closing
              ? `<button class="danger-button" type="button" data-action="reopen-period">마감 재오픈</button>`
              : `<button class="primary-button" type="button" data-action="close-period">월 마감 저장</button>`
          }
          <button class="secondary-button" type="button" data-action="export-period-summary">
            정산 내보내기
          </button>
        </div>
      </article>
    </section>

    <section class="split-line">
      <article class="card">
        <div class="section-title">
          <div>
            <h3>정산 요약</h3>
            <p>마감 전후 모두 같은 계산식을 사용합니다.</p>
          </div>
        </div>
        <div class="kpi-list">
          ${renderKpiRow("기간 기초잔액", formatCurrency(snapshot.openingBalance))}
          ${renderKpiRow("회비 입금", formatCurrency(snapshot.depositIncome))}
          ${renderKpiRow("이자 수입", formatCurrency(snapshot.interestIncome))}
          ${renderKpiRow("확정 수입", formatCurrency(snapshot.income))}
          ${renderKpiRow("지출", formatCurrency(snapshot.expense))}
          ${renderKpiRow("순증감", formatCurrency(snapshot.income - snapshot.expense))}
          ${renderKpiRow("기말잔액", formatCurrency(snapshot.closingBalance))}
          ${renderKpiRow("미납/부분 납부", `${snapshot.unpaidCount}명`)}
        </div>
      </article>

      <article class="card">
        <div class="section-title">
          <div>
            <h3>최근 마감 내역</h3>
            <p>직전 월 이월금 확인용입니다.</p>
          </div>
        </div>
        <div class="dues-card-list">
          ${
            recentClosings.length
              ? recentClosings
                  .slice(0, 4)
                  .map(
                    (item) => `
                      <article class="closing-card">
                        <header>
                          <div>
                            <h4>${monthLabel(item.period)}</h4>
                            <p>${item.status}</p>
                          </div>
                          <span class="status-badge ${item.status === "마감 완료" ? "status-closed" : "status-reopened"}">${item.status}</span>
                        </header>
                        <p>
                          기초 ${formatCurrency(item.openingBalance)} / 수입 ${formatCurrency(item.income)} / 지출 ${formatCurrency(item.expense)}
                        </p>
                        <p>기말 ${formatCurrency(item.closingBalance)}</p>
                      </article>
                    `,
                  )
                  .join("")
              : `<div class="empty-state">아직 저장된 마감 내역이 없습니다.</div>`
          }
        </div>
      </article>
    </section>

    <section class="data-table">
      <div class="section-title">
        <div>
          <h3>기간 거래 원장</h3>
          <p>수입과 지출을 같은 표에서 확인합니다.</p>
        </div>
      </div>
      ${
        ledgerRows.length
          ? `
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>일자</th>
                    <th>구분</th>
                    <th>설명</th>
                    <th>상태</th>
                    <th class="text-right">금액</th>
                  </tr>
                </thead>
                <tbody>
                  ${ledgerRows
                    .map(
                      (row) => `
                        <tr>
                          <td>${formatDate(row.date)}</td>
                          <td>${row.kind}</td>
                          <td>${escapeHtml(row.label)}</td>
                          <td>${renderBadge(row.status)}</td>
                          <td class="text-right">${formatCurrency(row.amount)}</td>
                        </tr>
                      `,
                    )
                    .join("")}
                </tbody>
              </table>
            </div>
          `
          : `<div class="empty-state">선택한 기간의 거래가 없습니다.</div>`
      }
    </section>
  `;
}

function renderHistory() {
  const items = filterHistory();
  return `
    <section class="data-table">
      <div class="section-title">
        <div>
          <h3>변경 이력</h3>
          <p>회원, 입금, 지출, 기초잔액, 월 마감 변경을 추적합니다.</p>
        </div>
      </div>
      <div class="filter-strip">
        <label class="inline-field">
          <span>대상</span>
          <select data-filter-key="historyType">
            ${renderOptions(
              [
                { value: "all", label: "전체" },
                { value: "회원", label: "회원" },
                { value: "회비", label: "회비" },
                { value: "입금", label: "입금" },
                { value: "지출", label: "지출" },
                { value: "소모임", label: "소모임" },
                { value: "정산", label: "정산" },
                { value: "설정", label: "설정" },
              ],
              state.ui.filters.historyType,
            )}
          </select>
        </label>
        <label class="inline-field">
          <span>행위</span>
          <select data-filter-key="historyAction">
            ${renderOptions(
              [
                { value: "all", label: "전체" },
                { value: "생성", label: "생성" },
                { value: "수정", label: "수정" },
                { value: "삭제", label: "삭제" },
                { value: "설정", label: "설정" },
                { value: "반영", label: "반영" },
                { value: "마감", label: "마감" },
                { value: "재오픈", label: "재오픈" },
              ],
              state.ui.filters.historyAction,
            )}
          </select>
        </label>
      </div>
      ${
        items.length
          ? `
            <div class="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>시각</th>
                    <th>대상</th>
                    <th>행위</th>
                    <th>요약</th>
                    <th>수행자</th>
                  </tr>
                </thead>
                <tbody>
                  ${items
                    .map(
                      (item) => `
                        <tr>
                          <td>${formatDateTime(item.at)}</td>
                          <td>${escapeHtml(item.entityType)} / ${escapeHtml(item.entityLabel)}</td>
                          <td>${renderBadge(item.action)}</td>
                          <td>${escapeHtml(item.summary)}</td>
                          <td>${escapeHtml(item.actor || "총무")}</td>
                        </tr>
                      `,
                    )
                    .join("")}
                </tbody>
              </table>
            </div>
          `
          : `<div class="empty-state">조건에 맞는 이력이 없습니다.</div>`
      }
    </section>
  `;
}

function renderSettings() {
  const currentGroup = getCurrentGroup();
  const syncMeta = getSyncIndicatorMeta();
  return `
    <section class="section-grid">
      <div class="stack">
        <article class="card">
          <div class="section-title">
            <div>
              <h3>현재 모임</h3>
              <p>선택 중인 모임과 기초 정보입니다.</p>
            </div>
          </div>
          <div class="kpi-list">
            ${renderKpiRow("모임명", escapeHtml(currentGroup?.name || "-"))}
            ${renderKpiRow("모임 유형", escapeHtml(currentGroup?.kind || "-"))}
            ${renderKpiRow("설명", escapeHtml(currentGroup?.description || "-"))}
            ${renderKpiRow("기초잔액", formatCurrency(currentGroup?.initialOpeningBalance || 0))}
            ${renderKpiRow("월회비 기준금액", formatCurrency(currentGroup?.regularMonthlyFee || 0))}
          </div>
        </article>

        <article class="card">
          <div class="section-title">
            <div>
              <h3>저장 · 전달 방식</h3>
              <p>${syncState.available ? "현재는 서버 저장과 기기 자동 반영을 같이 지원합니다." : "지금은 이 기기 안에 자동 저장됩니다. 다른 기기로 옮길 때만 백업 파일을 내보내면 됩니다."}</p>
            </div>
          </div>
          <div class="kpi-list">
            ${renderKpiRow("현재 상태", escapeHtml(syncMeta.text))}
            ${renderKpiRow("저장 위치", syncState.available ? "서버 저장 + 이 기기 백업" : `이 기기 ${escapeHtml(syncState.localStorageLabel)}`)}
            ${renderKpiRow("현재 주소", escapeHtml(window.location.origin))}
          </div>
        </article>

        <article class="card">
          <div class="section-title">
            <div>
              <h3>모바일 설치 · 이전</h3>
              <p>아이폰 총무 전용기기로 쓰려면 홈 화면에 설치한 뒤, 백업 파일로 다른 기기에 옮기면 됩니다.</p>
            </div>
          </div>
          <div class="note-panel">
            <div class="soft-tag">아이폰 Safari 열기 → 공유 → 홈 화면에 추가</div>
            <div class="soft-tag">작성 내용은 기기 안에 저장</div>
            <div class="soft-tag">기기 변경 시 전체 데이터 백업 파일 내보내기</div>
            <div class="soft-tag">새 기기에서 백업 파일 불러오기</div>
          </div>
        </article>

        <article class="form-panel">
          <div class="section-title">
            <div>
              <h3>기초값 설정</h3>
              <p>초기 기초잔액과 고정 월회비 기준금액을 같이 관리합니다.</p>
            </div>
          </div>
          <form id="opening-balance-form">
            <div class="form-grid">
              <label class="field-stack">
                <span>초기 기초잔액</span>
                <input name="amount" type="number" min="0" value="${currentGroup?.initialOpeningBalance || 0}" required />
              </label>
              <label class="field-stack">
                <span>월회비 기준금액</span>
                <input
                  name="regularMonthlyFee"
                  type="number"
                  min="0"
                  value="${currentGroup?.regularMonthlyFee || 0}"
                  required
                />
              </label>
            </div>
            <div class="form-actions">
              <button class="primary-button" type="submit">기초값 저장</button>
            </div>
          </form>
        </article>

        <article class="card">
          <div class="section-title">
            <div>
              <h3>운영 메모</h3>
              <p>현재 데모 정책입니다.</p>
            </div>
          </div>
          <div class="note-panel">
            <div class="soft-tag">마감된 월은 재오픈 전까지 수정 금지</div>
            <div class="soft-tag">확인 필요 입금은 확정 수입에 포함하지 않음</div>
            <div class="soft-tag">영수증 파일은 파일명만 저장</div>
          </div>
        </article>

        <article class="form-panel">
          <div class="section-title">
            <div>
              <h3>관리 도구</h3>
              <p>모바일 전용 사용을 고려해 전체 백업, 공유, 복원을 이 화면에 모았습니다.</p>
            </div>
          </div>
          <div class="form-actions">
            <button class="primary-button" type="button" data-action="export-backup">전체 데이터 백업</button>
            <button class="ghost-button" type="button" data-action="share-backup">백업 공유</button>
            <button class="ghost-button" type="button" data-action="import-backup">백업 불러오기</button>
            <button class="ghost-button" type="button" data-action="export-state">JSON 내보내기</button>
            <button class="danger-outline" type="button" data-action="reset-demo">샘플 데이터 다시 불러오기</button>
          </div>
          <input id="backup-import-input" class="visually-hidden" type="file" accept="application/json,.json" />
          <p class="helper-text">전체 데이터 백업은 모든 모임을 한 번에 저장합니다. 다른 기기에서는 백업 불러오기로 그대로 복원합니다.</p>
        </article>
      </div>

      <aside class="stack">
        <article class="form-panel">
          <div class="section-title">
            <div>
              <h3>모임 목록</h3>
              <p>정규모임을 추가하거나, 필요 없는 모임은 삭제할 수 있습니다.</p>
            </div>
          </div>
          <div class="category-list" style="margin-bottom:16px;">
            ${getGroups().map(renderGroupManagementItem).join("")}
          </div>
        </article>

        <article class="form-panel">
          <div class="section-title">
            <div>
              <h3>새 모임 추가</h3>
              <p>정규모임 또는 완전히 독립된 1회성 인스턴트모임을 새로 만듭니다.</p>
            </div>
          </div>
          <form id="group-form" style="margin-bottom:18px;">
            <div class="form-grid single">
              <label class="field-stack">
                <span>모임 유형</span>
                <select name="groupKind">
                  ${renderOptions(
                    [
                      { value: "정규모임", label: "정규모임" },
                      { value: "인스턴트모임", label: "인스턴트모임" },
                    ],
                    "정규모임",
                  )}
                </select>
              </label>
              <label class="field-stack">
                <span>모임 이름</span>
                <input name="groupName" required placeholder="예: 풋살모임" />
              </label>
              <label class="field-stack">
                <span>설명</span>
                <input name="groupDescription" placeholder="예: 주말 풋살 정산" />
              </label>
              <label class="field-stack">
                <span>초기 기초잔액</span>
                <input name="groupOpeningBalance" type="number" min="0" value="0" />
              </label>
              <label class="field-stack">
                <span>월회비 기준금액</span>
                <input name="groupMonthlyFee" type="number" min="0" value="0" />
              </label>
            </div>
            <p class="helper-text" style="margin-top:12px;">
              정규모임은 독서모임, 풋살모임처럼 계속 운영하는 모임입니다. 인스턴트모임은 완전히 별개 멤버로 한 번만 회비/정산할 때 쓰는 독립 모임입니다.
            </p>
            <div class="form-actions">
              <button class="primary-button" type="submit">모임 추가</button>
            </div>
          </form>
        </article>

        <article class="form-panel">
          <div class="section-title">
            <div>
              <h3>지출 카테고리</h3>
              <p>비활성화된 카테고리는 신규 지출에서 제외됩니다.</p>
            </div>
          </div>
          <div class="category-list" style="margin-bottom:16px;">
            ${getCategories().map(renderCategoryItem).join("")}
          </div>
          <form id="category-form">
            <div class="form-grid single">
              <label class="field-stack">
                <span>새 카테고리 이름</span>
                <input name="categoryName" required placeholder="예: 교통비" />
              </label>
            </div>
            <div class="form-actions">
              <button class="primary-button" type="submit">카테고리 추가</button>
            </div>
          </form>
        </article>
      </aside>
    </section>
  `;
}

function renderMemberTable(members) {
  if (!members.length) {
    return `<div class="empty-state">조건에 맞는 회원이 없습니다.</div>`;
  }
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>이름</th>
            <th>가입일</th>
            <th>연락처</th>
            <th>입금자명</th>
            <th>회비 대상</th>
            <th>상태</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${members
            .map(
              (member) => `
                <tr>
                  <td>
                    <strong>${escapeHtml(member.name)}</strong>
                    <div class="muted">${escapeHtml(member.nickname || "")}</div>
                  </td>
                  <td>${escapeHtml(member.joinDate || "-")}</td>
                  <td>${escapeHtml(member.contact || "-")}</td>
                  <td>${escapeHtml(member.payerName || "-")}</td>
                  <td>${member.duesEligible ? renderBadge("대상") : renderBadge("비대상")}</td>
                  <td>${renderBadge(member.status)}</td>
                  <td>
                    <div class="table-actions">
                      <button class="ghost-button" type="button" data-action="edit-member" data-id="${member.id}">
                        수정
                      </button>
                    </div>
                  </td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderDueCard(due) {
  const counts = getDueCounts(due.id);
  return `
    <article class="due-card ${due.id === state.ui.selectedDueId ? "is-selected" : ""}">
      <header>
        <div>
          <h4>${escapeHtml(due.title)}</h4>
          <p>${due.type} · ${formatCurrency(due.amount)} · 마감 ${formatDate(due.dueDate)}</p>
        </div>
        <div class="table-actions">
          <button class="secondary-button" type="button" data-action="select-due" data-id="${due.id}">
            보기
          </button>
          <button class="ghost-button" type="button" data-action="edit-due" data-id="${due.id}">
            수정
          </button>
        </div>
      </header>
      <div class="badge-row" style="margin-top:12px;">
        <span class="status-badge status-paid">완납 ${counts.paidCount}</span>
        <span class="status-badge status-unpaid">미납 ${counts.unpaidOnlyCount}</span>
        <span class="status-badge status-review">검토 ${counts.reviewCount}</span>
      </div>
    </article>
  `;
}

function renderAssignmentTable(assignments, due) {
  if (!assignments.length) {
    return `<div class="empty-state">조건에 맞는 납부 상태가 없습니다.</div>`;
  }
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>회원</th>
            <th>입금자명</th>
            <th>납부금액</th>
            <th>상태</th>
            <th>수동 상태</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${assignments
            .map((assignment) => {
              const member = getMember(assignment.memberId);
              return `
                <tr>
                  <td>${escapeHtml(member?.name || "알 수 없음")}</td>
                  <td>${escapeHtml(member?.payerName || member?.nickname || "-")}</td>
                  <td>${formatCurrency(assignment.paidAmount)}</td>
                  <td>${renderBadge(assignment.status)}</td>
                  <td>
                    <select data-assignment-status="${assignment.id}">
                      ${renderOptions(
                        [
                          { value: "자동", label: "입금 기준" },
                          { value: "미납", label: "미납" },
                          { value: "납부 완료", label: "납부 완료" },
                          { value: "부분 납부", label: "부분 납부" },
                          { value: "확인 필요", label: "확인 필요" },
                          { value: "면제", label: "면제" },
                        ],
                        assignment.manualStatus || "자동",
                      )}
                    </select>
                  </td>
                  <td>
                    <button
                      class="ghost-button"
                      type="button"
                      data-action="prepare-deposit"
                      data-member-id="${member?.id || ""}"
                      data-due-id="${due.id}"
                    >
                      입금 등록
                    </button>
                  </td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderDepositTable(deposits, withActions) {
  if (!deposits.length) {
    return `<div class="empty-state">표시할 입금이 없습니다.</div>`;
  }
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>입금일</th>
            <th>입금자명</th>
            <th>회원 / 회비</th>
            <th>상태</th>
            <th class="text-right">금액</th>
            ${withActions ? "<th></th>" : ""}
          </tr>
        </thead>
        <tbody>
          ${deposits
            .map((deposit) => {
              const member = getMember(deposit.memberId);
              const due = getDue(deposit.dueId);
              return `
                <tr>
                  <td>${formatDate(deposit.date)}</td>
                  <td>${escapeHtml(deposit.payerName || "-")}</td>
                  <td>
                    <strong>${escapeHtml(member?.name || "미지정")}</strong>
                    <div class="muted">${escapeHtml(due?.title || "회비 미지정")}</div>
                  </td>
                  <td>${renderBadge(deposit.status)}</td>
                  <td class="text-right">${formatCurrency(deposit.amount)}</td>
                  ${
                    withActions
                      ? `<td>
                          <div class="table-actions">
                            <button class="ghost-button" type="button" data-action="edit-deposit" data-id="${deposit.id}">수정</button>
                            <button class="danger-outline" type="button" data-action="delete-deposit" data-id="${deposit.id}">삭제</button>
                          </div>
                        </td>`
                      : ""
                  }
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderIncomeEntryTable(entries, withActions) {
  if (!entries.length) {
    return `<div class="empty-state">등록된 이자 수입이 없습니다.</div>`;
  }
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>일자</th>
            <th>구분</th>
            <th>메모</th>
            <th class="text-right">금액</th>
            ${withActions ? "<th></th>" : ""}
          </tr>
        </thead>
        <tbody>
          ${entries
            .map(
              (entry) => `
                <tr>
                  <td>${formatDate(entry.date)}</td>
                  <td>${renderBadge(entry.type)}</td>
                  <td>${escapeHtml(entry.note || "-")}</td>
                  <td class="text-right">${formatCurrency(entry.amount)}</td>
                  ${
                    withActions
                      ? `<td>
                          <div class="table-actions">
                            <button class="ghost-button" type="button" data-action="edit-income" data-id="${entry.id}">수정</button>
                            <button class="danger-outline" type="button" data-action="delete-income" data-id="${entry.id}">삭제</button>
                          </div>
                        </td>`
                      : ""
                  }
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderExpenseTable(expenses, withActions) {
  if (!expenses.length) {
    return `<div class="empty-state">표시할 지출이 없습니다.</div>`;
  }
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>지출일</th>
            <th>카테고리</th>
            <th>사용처</th>
            <th>목적</th>
            <th>증빙</th>
            <th class="text-right">금액</th>
            ${withActions ? "<th></th>" : ""}
          </tr>
        </thead>
        <tbody>
          ${expenses
            .map(
              (expense) => `
                <tr>
                  <td>${formatDate(expense.date)}</td>
                  <td>${renderBadge(expense.category)}</td>
                  <td>${escapeHtml(expense.vendor)}</td>
                  <td>${escapeHtml(expense.purpose || "-")}</td>
                  <td>${expense.receiptName ? escapeHtml(expense.receiptName) : "<span class=\"muted\">없음</span>"}</td>
                  <td class="text-right">${formatCurrency(expense.amount)}</td>
                  ${
                    withActions
                      ? `<td>
                          <div class="table-actions">
                            <button class="ghost-button" type="button" data-action="edit-expense" data-id="${expense.id}">수정</button>
                            <button class="danger-outline" type="button" data-action="delete-expense" data-id="${expense.id}">삭제</button>
                          </div>
                        </td>`
                      : ""
                  }
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderTempMeetingCard(meeting) {
  const snapshot = getTempMeetingSnapshot(meeting);
  return `
    <article class="due-card ${meeting.id === state.ui.selectedTempMeetingId ? "is-selected" : ""}">
      <header>
        <div>
          <h4>${escapeHtml(meeting.name)}</h4>
          <p>${formatDate(meeting.date)} · 참여 ${meeting.participantIds.length}명 · ${meeting.status}</p>
        </div>
        <div class="table-actions">
          <button class="secondary-button" type="button" data-action="select-temp-meeting" data-id="${meeting.id}">보기</button>
          ${
            meeting.status !== "반영 완료"
              ? `<button class="primary-button" type="button" data-action="reflect-temp-meeting" data-id="${meeting.id}">정규 반영</button>`
              : ""
          }
          <button class="danger-outline" type="button" data-action="delete-temp-meeting" data-id="${meeting.id}">삭제</button>
        </div>
      </header>
      <div class="badge-row" style="margin-top:12px;">
        <span class="status-badge status-paid">지출 ${formatCurrency(snapshot.expenseTotal)}</span>
        <span class="status-badge status-partial">납부 ${formatCurrency(snapshot.paymentTotal)}</span>
        <span class="status-badge ${snapshot.balanceTotal > 0 ? "status-review" : "status-closed"}">미정산 ${formatCurrency(snapshot.balanceTotal)}</span>
      </div>
    </article>
  `;
}

function renderTempMeetingSettlementTable(rows) {
  if (!rows.length) {
    return `<div class="empty-state">참여 인원이 없습니다.</div>`;
  }
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>회원</th>
            <th class="text-right">기본 부담액</th>
            <th class="text-right">예외 조정</th>
            <th class="text-right">최종 부담액</th>
            <th class="text-right">납부액</th>
            <th class="text-right">남은 금액</th>
          </tr>
        </thead>
        <tbody>
          ${rows
            .map(
              (row) => `
                <tr>
                  <td>
                    <strong>${escapeHtml(row.member.name)}</strong>
                    <div class="muted">${escapeHtml(row.member.payerName || row.member.nickname || "-")}</div>
                  </td>
                  <td class="text-right">${formatCurrency(row.baseAmount)}</td>
                  <td class="text-right">${formatSignedCurrency(row.adjustmentAmount)}</td>
                  <td class="text-right">${formatCurrency(row.owedAmount)}</td>
                  <td class="text-right">${formatCurrency(row.paidAmount)}</td>
                  <td class="text-right">
                    ${row.balance > 0 ? renderBadge("미정산") : row.balance < 0 ? renderBadge("초과 납부") : renderBadge("완료")}
                    <div style="margin-top:6px;">${formatSignedCurrency(row.balance)}</div>
                  </td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderTempMeetingExpenseTable(expenses) {
  if (!expenses.length) {
    return `<div class="empty-state">등록된 소모임 지출이 없습니다.</div>`;
  }
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>일자</th>
            <th>사용처</th>
            <th>목적</th>
            <th>적용 인원</th>
            <th class="text-right">금액</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${expenses
            .map(
              (expense) => `
                <tr>
                  <td>${formatDate(expense.date)}</td>
                  <td>
                    <strong>${escapeHtml(expense.vendor)}</strong>
                    <div class="muted">${escapeHtml(expense.category)}</div>
                  </td>
                  <td>${escapeHtml(expense.purpose || "-")}</td>
                  <td>${escapeHtml(expense.participantIds.map((memberId) => getMember(memberId)?.name || "알 수 없음").join(", "))}</td>
                  <td class="text-right">${formatCurrency(expense.amount)}</td>
                  <td>
                    <button class="danger-outline" type="button" data-action="delete-temp-expense" data-id="${expense.id}">삭제</button>
                  </td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderTempMeetingPaymentTable(payments) {
  if (!payments.length) {
    return `<div class="empty-state">등록된 소모임 납부가 없습니다.</div>`;
  }
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>일자</th>
            <th>회원</th>
            <th>메모</th>
            <th class="text-right">금액</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${payments
            .map(
              (payment) => `
                <tr>
                  <td>${formatDate(payment.date)}</td>
                  <td>${escapeHtml(getMember(payment.memberId)?.name || "알 수 없음")}</td>
                  <td>${escapeHtml(payment.note || "-")}</td>
                  <td class="text-right">${formatCurrency(payment.amount)}</td>
                  <td>
                    <button class="danger-outline" type="button" data-action="delete-temp-payment" data-id="${payment.id}">삭제</button>
                  </td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderTempMeetingAdjustmentTable(adjustments) {
  if (!adjustments.length) {
    return `<div class="empty-state">등록된 예외 조정이 없습니다.</div>`;
  }
  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>회원</th>
            <th>사유</th>
            <th class="text-right">조정 금액</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${adjustments
            .map(
              (adjustment) => `
                <tr>
                  <td>${escapeHtml(getMember(adjustment.memberId)?.name || "알 수 없음")}</td>
                  <td>${escapeHtml(adjustment.reason)}</td>
                  <td class="text-right">${formatSignedCurrency(adjustment.amount)}</td>
                  <td>
                    <button class="danger-outline" type="button" data-action="delete-temp-adjustment" data-id="${adjustment.id}">삭제</button>
                  </td>
                </tr>
              `,
            )
            .join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderGroupManagementItem(group) {
  const isCurrent = group.id === getCurrentGroupId();
  return `
    <div class="category-item ${isCurrent ? "is-current-group" : ""}">
      <div>
        <strong>${escapeHtml(group.name)}</strong>
        <div class="muted">${escapeHtml(group.kind)} · ${escapeHtml(group.description || "설명 없음")}</div>
      </div>
      <div class="table-actions">
        <button class="secondary-button" type="button" data-action="select-group" data-id="${group.id}">
          ${isCurrent ? "선택 중" : "이동"}
        </button>
        <button class="danger-outline" type="button" data-action="delete-group" data-id="${group.id}">
          삭제
        </button>
      </div>
    </div>
  `;
}

function renderCategoryItem(category) {
  return `
    <div class="category-item">
      <div>
        <strong>${escapeHtml(category.name)}</strong>
        <div class="muted">${category.active ? "신규 지출에서 사용 가능" : "비활성화됨"}</div>
      </div>
      <button
        class="${category.active ? "danger-outline" : "secondary-button"}"
        type="button"
        data-action="toggle-category"
        data-id="${category.id}"
      >
        ${category.active ? "비활성화" : "다시 활성화"}
      </button>
    </div>
  `;
}

function renderKpiRow(label, value) {
  return `
    <div class="kpi-row">
      <span>${label}</span>
      <strong>${value}</strong>
    </div>
  `;
}

function renderOptions(options, selectedValue) {
  return options
    .map(
      (option) => `
        <option value="${escapeHtml(option.value)}" ${option.value === selectedValue ? "selected" : ""}>
          ${escapeHtml(option.label)}
        </option>
      `,
    )
    .join("");
}

function renderPeriodOptions(selectedPeriod) {
  const options = getAvailablePeriods(selectedPeriod).map((period) => ({
    value: period,
    label: monthLabel(period),
  }));
  return renderOptions(options, selectedPeriod);
}

function renderBadge(value) {
  const normalized = {
    "납부 완료": "status-paid",
    활성: "status-active",
    "마감 완료": "status-closed",
    완료: "status-closed",
    미납: "status-unpaid",
    미정산: "status-review",
    "확인 필요": "status-review",
    재오픈: "status-reopened",
    반영: "status-paid",
    "반영 완료": "status-closed",
    "진행 중": "status-active",
    "초과 납부": "status-partial",
    "부분 납부": "status-partial",
    비활성: "status-inactive",
    면제: "status-exempt",
  }[value] || "soft-tag";

  if (normalized === "soft-tag") {
    return `<span class="soft-tag">${escapeHtml(value)}</span>`;
  }

  return `<span class="status-badge ${normalized}">${escapeHtml(value)}</span>`;
}

function handleClick(event) {
  const trigger = event.target.closest("[data-action]");
  if (!trigger) {
    return;
  }

  const { action } = trigger.dataset;

  switch (action) {
    case "go-home":
      state.ui.currentTab = "dashboard";
      renderApp();
      scrollPageTop();
      return;
    case "select-tab":
      state.ui.currentTab = trigger.dataset.tab;
      renderApp();
      scrollPageTop();
      return;
    case "close-flash":
      state.ui.flash = null;
      renderApp();
      return;
    case "new-member":
      state.ui.currentTab = "members";
      state.ui.editing.memberId = "";
      renderApp();
      return;
    case "edit-member":
      state.ui.currentTab = "members";
      state.ui.editing.memberId = trigger.dataset.id;
      renderApp();
      return;
    case "clear-member-form":
      state.ui.editing.memberId = "";
      renderApp();
      return;
    case "new-due":
      state.ui.currentTab = "dues";
      state.ui.editing.dueId = "";
      renderApp();
      return;
    case "edit-due":
      state.ui.currentTab = "dues";
      state.ui.editing.dueId = trigger.dataset.id;
      state.ui.selectedDueId = trigger.dataset.id;
      renderApp();
      return;
    case "select-due":
      state.ui.selectedDueId = trigger.dataset.id;
      renderApp();
      return;
    case "clear-due-form":
      state.ui.editing.dueId = "";
      renderApp();
      return;
    case "new-deposit":
      state.ui.currentTab = "deposits";
      state.ui.editing.depositId = "";
      state.ui.depositDraft = createDepositDraft({ dueId: state.ui.selectedDueId || "" });
      renderApp();
      return;
    case "prepare-deposit":
      state.ui.currentTab = "deposits";
      state.ui.editing.depositId = "";
      state.ui.depositDraft = createDepositDraft({
        memberId: trigger.dataset.memberId || "",
        dueId: trigger.dataset.dueId || "",
      });
      renderApp();
      return;
    case "edit-deposit":
      editDeposit(trigger.dataset.id);
      return;
    case "set-deposit-amount": {
      const depositAmountInput = document.querySelector('#deposit-form input[name="amount"]');
      if (depositAmountInput) {
        depositAmountInput.value = trigger.dataset.amount || "";
      }
      return;
    }
    case "clear-deposit-form":
      state.ui.editing.depositId = "";
      state.ui.depositDraft = createDepositDraft({ dueId: state.ui.selectedDueId || "" });
      renderApp();
      return;
    case "delete-deposit":
      removeDeposit(trigger.dataset.id);
      return;
    case "edit-income":
      editIncomeEntry(trigger.dataset.id);
      return;
    case "clear-income-form":
      state.ui.editing.incomeId = "";
      renderApp();
      return;
    case "delete-income":
      removeIncomeEntry(trigger.dataset.id);
      return;
    case "new-expense":
      state.ui.currentTab = "expenses";
      state.ui.editing.expenseId = "";
      renderApp();
      return;
    case "edit-expense":
      state.ui.currentTab = "expenses";
      state.ui.editing.expenseId = trigger.dataset.id;
      renderApp();
      return;
    case "clear-expense-form":
      state.ui.editing.expenseId = "";
      renderApp();
      return;
    case "delete-expense":
      removeExpense(trigger.dataset.id);
      return;
    case "select-temp-meeting":
      state.ui.currentTab = "submeetings";
      state.ui.selectedTempMeetingId = trigger.dataset.id || "";
      renderApp();
      return;
    case "select-group":
      state.ui.selectedGroupId = trigger.dataset.id || state.groups[0]?.id || "";
      state.ui.currentTab = "settings";
      clearEditingState();
      syncSelectedDue();
      syncSelectedTempMeeting();
      renderApp();
      scrollPageTop();
      return;
    case "delete-temp-meeting":
      removeTempMeeting(trigger.dataset.id);
      return;
    case "reflect-temp-meeting":
      reflectTempMeeting(trigger.dataset.id);
      return;
    case "delete-temp-expense":
      removeTempMeetingExpense(trigger.dataset.id);
      return;
    case "delete-temp-payment":
      removeTempMeetingPayment(trigger.dataset.id);
      return;
    case "delete-temp-adjustment":
      removeTempMeetingAdjustment(trigger.dataset.id);
      return;
    case "close-period":
      closePeriod(state.ui.selectedPeriod);
      return;
    case "reopen-period":
      reopenPeriod(state.ui.selectedPeriod);
      return;
    case "export-state":
      exportState();
      return;
    case "export-backup":
      exportFullBackup();
      return;
    case "share-backup":
      void shareFullBackup();
      return;
    case "import-backup":
      triggerBackupImport();
      return;
    case "export-period-summary":
      exportPeriodSummary();
      return;
    case "toggle-category":
      toggleCategory(trigger.dataset.id);
      return;
    case "delete-group":
      deleteGroup(trigger.dataset.id);
      return;
    case "reset-demo":
      resetDemo();
      return;
    default:
      return;
  }
}

function handleChange(event) {
  const target = event.target;

  if (target.id === "group-picker") {
    state.ui.selectedGroupId = target.value || state.groups[0]?.id || "";
    clearEditingState();
    syncSelectedDue();
    syncSelectedTempMeeting();
    renderApp();
    scrollPageTop();
    return;
  }

  if (target.id === "period-picker") {
    state.ui.selectedPeriod = target.value || currentPeriod();
    syncSelectedDue();
    renderApp();
    scrollPageTop();
    return;
  }

  if (target.id === "backup-import-input") {
    const file = target.files?.[0];
    if (file) {
      void importBackupFile(file, target);
    }
    return;
  }

  if (target.form?.id === "deposit-form" && !state.ui.editing.depositId) {
    if (target.name === "memberId") {
      const nextMemberId = target.value || "";
      const currentDue = getDue(state.ui.depositDraft.dueId);
      const nextDueId =
        currentDue && (!nextMemberId || currentDue.targetMemberIds.includes(nextMemberId))
          ? currentDue.id
          : getDepositDueOptions(nextMemberId)[0]?.id || "";
      state.ui.depositDraft = createDepositDraft({
        memberId: nextMemberId,
        dueId: nextDueId,
        status: state.ui.depositDraft.status,
      });
      renderApp();
      return;
    }

    if (target.name === "dueId") {
      state.ui.depositDraft = createDepositDraft({
        memberId: state.ui.depositDraft.memberId,
        dueId: target.value || "",
        status: state.ui.depositDraft.status,
      });
      renderApp();
      return;
    }

    if (target.name === "statusChoice") {
      state.ui.depositDraft = createDepositDraft({
        memberId: state.ui.depositDraft.memberId,
        dueId: state.ui.depositDraft.dueId,
        status: target.value || "납부 완료",
      });
      return;
    }
  }

  if (target.dataset.filterKey) {
    state.ui.filters[target.dataset.filterKey] = target.value;
    renderApp();
    return;
  }

  if (target.dataset.assignmentStatus) {
    updateAssignmentStatus(target.dataset.assignmentStatus, target.value);
  }
}

function handleSubmit(event) {
  event.preventDefault();
  const form = event.target;

  switch (form.id) {
    case "member-form":
      submitMember(form);
      return;
    case "due-form":
      submitDue(form);
      return;
    case "deposit-form":
      submitDeposit(form);
      return;
    case "income-form":
      submitIncomeEntry(form);
      return;
    case "expense-form":
      submitExpense(form);
      return;
    case "temp-meeting-form":
      submitTempMeeting(form);
      return;
    case "temp-expense-form":
      submitTempMeetingExpense(form);
      return;
    case "temp-payment-form":
      submitTempMeetingPayment(form);
      return;
    case "temp-adjustment-form":
      submitTempMeetingAdjustment(form);
      return;
    case "opening-balance-form":
      submitOpeningBalance(form);
      return;
    case "group-form":
      submitGroup(form);
      return;
    case "category-form":
      submitCategory(form);
      return;
    default:
      return;
  }
}

function submitMember(form) {
  const formData = new FormData(form);
  const editingId = formData.get("editingId");
  const payload = {
    name: String(formData.get("name") || "").trim(),
    nickname: String(formData.get("nickname") || "").trim(),
    contact: String(formData.get("contact") || "").trim(),
    joinDate: normalizeDateValue(formData.get("joinDate") || ""),
    payerName: String(formData.get("payerName") || "").trim(),
    duesEligible: formData.get("duesEligible") === "on",
    status: String(formData.get("status") || "활성"),
    memo: String(formData.get("memo") || "").trim(),
  };

  if (!payload.name) {
    return flash("이름은 필수입니다.", "danger");
  }

  if (editingId) {
    const member = getMember(editingId);
    if (!member) {
      return flash("수정할 회원을 찾지 못했습니다.", "danger");
    }

    Object.assign(member, payload);
    logHistory({
      entityType: "회원",
      entityId: member.id,
      entityLabel: member.name,
      action: "수정",
      summary: `${member.name} 회원 정보를 수정했습니다.`,
    });
    state.ui.editing.memberId = "";
    persist("회원 정보를 수정했습니다.");
    return;
  }

  const member = {
    id: uid("member"),
    groupId: getCurrentGroupId(),
    ...payload,
  };
  state.members.push(member);
  logHistory({
    entityType: "회원",
    entityId: member.id,
    entityLabel: member.name,
    action: "생성",
    summary: `${member.name} 회원을 등록했습니다.`,
  });
  persist("새 회원을 등록했습니다.");
  form.reset();
}

function submitDue(form) {
  const formData = new FormData(form);
  const editingId = formData.get("editingId");
  const payload = {
    title: String(formData.get("title") || "").trim(),
    type: String(formData.get("type") || "월회비"),
    amount: asNumber(formData.get("amount")),
    dueDate: String(formData.get("dueDate") || ""),
    note: String(formData.get("note") || "").trim(),
  };

  if (!payload.title || payload.amount <= 0) {
    return flash("회비명과 금액은 필수입니다.", "danger");
  }

  if (editingId) {
    const due = getDue(editingId);
    if (!due) {
      return flash("수정할 회비 항목을 찾지 못했습니다.", "danger");
    }
    if (isPeriodClosed(due.period)) {
      return flash("마감된 월의 회비 항목은 재오픈 전까지 수정할 수 없습니다.", "danger");
    }

    Object.assign(due, payload);
    recalculateAllAssignments(state);
    logHistory({
      entityType: "회비",
      entityId: due.id,
      entityLabel: due.title,
      action: "수정",
      summary: `${due.title} 항목을 수정했습니다.`,
    });
    state.ui.editing.dueId = "";
    persist("회비 항목을 수정했습니다.");
    return;
  }

  const period = String(formData.get("period") || state.ui.selectedPeriod);
  const targetMode = String(formData.get("targetMode") || "all");
  const targetMemberIds =
    targetMode === "all"
      ? getMembers().filter(isEligibleMember).map((member) => member.id)
      : unique(formData.getAll("targetMemberIds").map(String).filter(Boolean));

  if (!targetMemberIds.length) {
    return flash("대상 회원을 최소 1명 이상 지정해야 합니다.", "danger");
  }

  const due = {
    id: uid("due"),
    groupId: getCurrentGroupId(),
    title: payload.title,
    type: payload.type,
    amount: payload.amount,
    period,
    dueDate: payload.dueDate,
    targetMemberIds,
    note: payload.note,
    createdAt: isoNow(),
  };

  state.dues.push(due);
  state.assignments.push(
    ...targetMemberIds.map((memberId) => createAssignment(getCurrentGroupId(), due.id, memberId)),
  );
  state.ui.selectedPeriod = period;
  state.ui.selectedDueId = due.id;
  logHistory({
    entityType: "회비",
    entityId: due.id,
    entityLabel: due.title,
    action: "생성",
    summary: `${due.title} 회비를 생성했습니다.`,
  });
  persist("회비 항목을 생성했습니다.");
  form.reset();
}

function submitDeposit(form) {
  const formData = new FormData(form);
  const editingId = String(formData.get("editingId") || "");
  const date = String(formData.get("date") || "");
  const period = periodOf(date);
  if (isPeriodClosed(period)) {
    return flash("마감된 월의 입금은 재오픈 전까지 수정할 수 없습니다.", "danger");
  }

  const record = {
    memberId: String(formData.get("memberId") || ""),
    dueId: String(formData.get("dueId") || ""),
    date,
    amount: asNumber(formData.get("amount")),
    payerName: String(formData.get("payerName") || "").trim(),
    memo: String(formData.get("memo") || "").trim(),
  };
  let statusChoice = String(formData.get("statusChoice") || "납부 완료");

  if (!record.payerName && record.memberId) {
    const member = getMember(record.memberId);
    record.payerName = member?.payerName || member?.name || "";
  }

  if (!record.date || record.amount <= 0) {
    return flash("입금일과 금액은 필수입니다.", "danger");
  }

  const duplicate = getDeposits().find(
    (deposit) =>
      !deposit.deletedAt &&
      deposit.id !== editingId &&
      deposit.memberId === record.memberId &&
      deposit.dueId === record.dueId &&
      deposit.date === record.date &&
      asNumber(deposit.amount) === record.amount,
  );
  if (duplicate && !window.confirm("같은 금액과 날짜의 입금이 이미 있습니다. 그래도 저장할까요?")) {
    return;
  }

  const status = resolveDepositStatus(record, statusChoice);
  let deposit;

  if (editingId) {
    deposit = getDeposit(editingId);
    if (!deposit) {
      return flash("수정할 입금을 찾지 못했습니다.", "danger");
    }
    Object.assign(deposit, record, { status });
    logHistory({
      entityType: "입금",
      entityId: deposit.id,
      entityLabel: deposit.payerName || "입금",
      action: "수정",
      summary: `${deposit.payerName || "입금"} 정보를 수정했습니다.`,
    });
  } else {
    deposit = createDepositRecord({ ...record, groupId: getCurrentGroupId(), status });
    state.deposits.push(deposit);
    logHistory({
      entityType: "입금",
      entityId: deposit.id,
      entityLabel: deposit.payerName || "입금",
      action: "생성",
      summary: `${deposit.payerName || "입금"} ${formatCurrency(deposit.amount)}을 등록했습니다.`,
    });
  }

  if (record.memberId && record.dueId) {
    const assignment = findOrCreateAssignment(record.dueId, record.memberId);
    assignment.manualStatus =
      statusChoice === "확인 필요" ? "확인 필요" : statusChoice === "부분 납부" ? "부분 납부" : "자동";
  }

  recalculateAllAssignments(state);
  state.ui.selectedPeriod = period;
  if (record.dueId) {
    state.ui.selectedDueId = record.dueId;
  }
  state.ui.editing.depositId = "";
  state.ui.depositDraft = createDepositDraft({ dueId: record.dueId || state.ui.selectedDueId || "" });
  persist(editingId ? "입금 정보를 수정했습니다." : "입금을 등록했습니다.");
  form.reset();
}

function submitIncomeEntry(form) {
  const formData = new FormData(form);
  const editingId = String(formData.get("editingId") || "");
  const date = String(formData.get("date") || "");
  const period = periodOf(date);
  if (isPeriodClosed(period)) {
    return flash("마감된 월의 이자 수입은 재오픈 전까지 수정할 수 없습니다.", "danger");
  }

  const payload = {
    date,
    amount: asNumber(formData.get("amount")),
    type: String(formData.get("type") || "이자").trim() || "이자",
    note: String(formData.get("note") || "").trim(),
  };

  if (!payload.date || payload.amount <= 0) {
    return flash("이자 날짜와 금액은 필수입니다.", "danger");
  }

  let entry;
  if (editingId) {
    entry = getIncomeEntries().find((item) => item.id === editingId) || null;
    if (!entry) {
      return flash("수정할 이자 수입을 찾지 못했습니다.", "danger");
    }
    Object.assign(entry, payload);
    logHistory({
      entityType: "수입",
      entityId: entry.id,
      entityLabel: entry.type,
      action: "수정",
      summary: `${entry.type} 수입을 수정했습니다.`,
    });
  } else {
    entry = createIncomeEntryRecord({
      ...payload,
      groupId: getCurrentGroupId(),
    });
    state.incomeEntries.push(entry);
    logHistory({
      entityType: "수입",
      entityId: entry.id,
      entityLabel: entry.type,
      action: "생성",
      summary: `${entry.type} ${formatCurrency(entry.amount)}을 등록했습니다.`,
    });
  }

  state.ui.editing.incomeId = "";
  state.ui.selectedPeriod = period;
  persist(editingId ? "이자 수입을 수정했습니다." : "이자 수입을 등록했습니다.");
  form.reset();
}

function submitExpense(form) {
  const formData = new FormData(form);
  const editingId = String(formData.get("editingId") || "");
  const date = String(formData.get("date") || "");
  const period = periodOf(date);
  if (isPeriodClosed(period)) {
    return flash("마감된 월의 지출은 재오픈 전까지 수정할 수 없습니다.", "danger");
  }

  const payload = {
    date,
    amount: asNumber(formData.get("amount")),
    category: String(formData.get("category") || "기타"),
    vendor: String(formData.get("vendor") || "").trim(),
    purpose: String(formData.get("purpose") || "").trim(),
    memo: String(formData.get("memo") || "").trim(),
  };

  if (!payload.date || payload.amount <= 0 || !payload.vendor) {
    return flash("지출일, 금액, 사용처는 필수입니다.", "danger");
  }

  const file = form.querySelector('input[name="receiptFile"]')?.files?.[0];
  let expense;

  if (editingId) {
    expense = getExpense(editingId);
    if (!expense) {
      return flash("수정할 지출을 찾지 못했습니다.", "danger");
    }
    Object.assign(expense, payload, { receiptName: file ? file.name : expense.receiptName });
    logHistory({
      entityType: "지출",
      entityId: expense.id,
      entityLabel: expense.vendor,
      action: "수정",
      summary: `${expense.vendor} 지출을 수정했습니다.`,
    });
  } else {
    expense = createExpenseRecord({
      ...payload,
      groupId: getCurrentGroupId(),
      receiptName: file ? file.name : "",
    });
    state.expenses.push(expense);
    logHistory({
      entityType: "지출",
      entityId: expense.id,
      entityLabel: expense.vendor,
      action: "생성",
      summary: `${expense.vendor} 지출 ${formatCurrency(expense.amount)}을 등록했습니다.`,
    });
  }

  state.ui.editing.expenseId = "";
  persist(editingId ? "지출을 수정했습니다." : "지출을 등록했습니다.");
  form.reset();
}

function submitOpeningBalance(form) {
  const formData = new FormData(form);
  const amount = asNumber(formData.get("amount"));
  const regularMonthlyFee = asNumber(formData.get("regularMonthlyFee"));
  if (amount < 0 || regularMonthlyFee < 0) {
    return flash("기초잔액과 월회비 기준금액은 0원 이상이어야 합니다.", "danger");
  }
  const group = getCurrentGroup();
  if (!group) {
    return flash("선택된 모임이 없습니다.", "danger");
  }
  group.initialOpeningBalance = amount;
  group.regularMonthlyFee = regularMonthlyFee;
  logHistory({
    entityType: "설정",
    entityId: `opening-balance-${group.id}`,
    entityLabel: "기초잔액",
    action: "설정",
    summary: `기초잔액 ${formatCurrency(amount)}, 월회비 기준금액 ${formatCurrency(regularMonthlyFee)}으로 설정했습니다.`,
  });
  persist("기초값을 저장했습니다.");
}

function submitGroup(form) {
  const formData = new FormData(form);
  const kind = String(formData.get("groupKind") || "정규모임");
  const name = String(formData.get("groupName") || "").trim();
  const description = String(formData.get("groupDescription") || "").trim();
  const openingBalance = asNumber(formData.get("groupOpeningBalance"));
  const regularMonthlyFee = asNumber(formData.get("groupMonthlyFee"));
  if (!name) {
    return flash("모임 이름을 입력하세요.", "danger");
  }
  if (openingBalance < 0 || regularMonthlyFee < 0) {
    return flash("기초잔액과 월회비 기준금액은 0원 이상이어야 합니다.", "danger");
  }
  const exists = state.groups.some((group) => group.name.toLowerCase() === name.toLowerCase());
  if (exists) {
    return flash("같은 이름의 모임이 이미 있습니다.", "danger");
  }
  const group = createGroupRecord({
    name,
    description,
    kind,
    initialOpeningBalance: openingBalance,
    regularMonthlyFee,
  });
  state.groups.push(group);
  ["식비", "대관료", "운영비", "기타"].forEach((categoryName) => {
    state.settings.categories.push({
      id: uid("cat"),
      groupId: group.id,
      name: categoryName,
      active: true,
    });
  });
  state.ui.selectedGroupId = group.id;
  clearEditingState();
  logHistory({
    groupId: group.id,
    entityType: "설정",
    entityId: group.id,
    entityLabel: group.name,
    action: "생성",
    summary: `${group.kind} ${group.name}을 추가했습니다.`,
  });
  persist(`${group.kind} ${group.name}을 추가했습니다.`);
  form.reset();
}

function submitCategory(form) {
  const formData = new FormData(form);
  const name = String(formData.get("categoryName") || "").trim();
  if (!name) {
    return flash("카테고리 이름을 입력하세요.", "danger");
  }
  const exists = getCategories().some(
    (category) => category.name.toLowerCase() === name.toLowerCase(),
  );
  if (exists) {
    return flash("같은 이름의 카테고리가 이미 있습니다.", "danger");
  }
  const category = { id: uid("cat"), groupId: getCurrentGroupId(), name, active: true };
  state.settings.categories.push(category);
  logHistory({
    entityType: "설정",
    entityId: category.id,
    entityLabel: category.name,
    action: "생성",
    summary: `${category.name} 카테고리를 추가했습니다.`,
  });
  persist("카테고리를 추가했습니다.");
  form.reset();
}

function submitTempMeeting(form) {
  const formData = new FormData(form);
  const name = String(formData.get("name") || "").trim();
  const date = String(formData.get("date") || "");
  const note = String(formData.get("note") || "").trim();
  const participantIds = unique(formData.getAll("participantIds").map(String).filter(Boolean));

  if (!name || !date) {
    return flash("임시모임 이름과 일자는 필수입니다.", "danger");
  }
  if (!participantIds.length) {
    return flash("참여 인원을 최소 1명 이상 선택하세요.", "danger");
  }

  const meeting = createTempMeetingRecord({
    groupId: getCurrentGroupId(),
    name,
    date,
    note,
    participantIds,
  });
  state.tempMeetings.push(meeting);
  state.ui.currentTab = "submeetings";
  state.ui.selectedTempMeetingId = meeting.id;
  logHistory({
    entityType: "소모임",
    entityId: meeting.id,
    entityLabel: meeting.name,
    action: "생성",
    summary: `${meeting.name} 임시모임을 추가했습니다.`,
  });
  persist("임시모임을 추가했습니다.");
  form.reset();
}

function submitTempMeetingExpense(form) {
  const formData = new FormData(form);
  const meeting = getTempMeeting(String(formData.get("tempMeetingId") || ""));
  if (!meeting) {
    return flash("선택된 임시모임을 찾지 못했습니다.", "danger");
  }
  if (meeting.status === "반영 완료") {
    return flash("이미 정규모임에 반영된 임시모임은 수정할 수 없습니다.", "danger");
  }
  const participantIds = unique(formData.getAll("participantIds").map(String).filter(Boolean));
  const amount = asNumber(formData.get("amount"));
  const vendor = String(formData.get("vendor") || "").trim();
  const record = {
    groupId: getCurrentGroupId(),
    tempMeetingId: meeting.id,
    date: String(formData.get("date") || ""),
    amount,
    category: String(formData.get("category") || "기타"),
    vendor,
    purpose: String(formData.get("purpose") || "").trim(),
    memo: String(formData.get("memo") || "").trim(),
    participantIds,
  };

  if (!record.date || amount <= 0 || !vendor) {
    return flash("지출일, 금액, 사용처는 필수입니다.", "danger");
  }
  if (!participantIds.length) {
    return flash("적용 인원을 최소 1명 이상 선택하세요.", "danger");
  }

  state.tempMeetingExpenses.push(createTempMeetingExpenseRecord(record));
  logHistory({
    entityType: "소모임",
    entityId: meeting.id,
    entityLabel: meeting.name,
    action: "수정",
    summary: `${meeting.name}에 ${vendor} 지출 ${formatCurrency(amount)}을 추가했습니다.`,
  });
  persist("소모임 지출을 추가했습니다.");
  form.reset();
}

function submitTempMeetingPayment(form) {
  const formData = new FormData(form);
  const meeting = getTempMeeting(String(formData.get("tempMeetingId") || ""));
  if (!meeting) {
    return flash("선택된 임시모임을 찾지 못했습니다.", "danger");
  }
  if (meeting.status === "반영 완료") {
    return flash("이미 정규모임에 반영된 임시모임은 수정할 수 없습니다.", "danger");
  }
  const amount = asNumber(formData.get("amount"));
  const memberId = String(formData.get("memberId") || "");
  const date = String(formData.get("date") || "");
  if (!memberId || !date || amount <= 0) {
    return flash("회원, 납부일, 금액은 필수입니다.", "danger");
  }

  state.tempMeetingPayments.push(
    createTempMeetingPaymentRecord({
      groupId: getCurrentGroupId(),
      tempMeetingId: meeting.id,
      memberId,
      date,
      amount,
      note: String(formData.get("note") || "").trim(),
    }),
  );
  logHistory({
    entityType: "소모임",
    entityId: meeting.id,
    entityLabel: meeting.name,
    action: "수정",
    summary: `${meeting.name}에 ${getMember(memberId)?.name || "회원"} 납부 ${formatCurrency(amount)}을 등록했습니다.`,
  });
  persist("소모임 납부를 등록했습니다.");
  form.reset();
}

function submitTempMeetingAdjustment(form) {
  const formData = new FormData(form);
  const meeting = getTempMeeting(String(formData.get("tempMeetingId") || ""));
  if (!meeting) {
    return flash("선택된 임시모임을 찾지 못했습니다.", "danger");
  }
  if (meeting.status === "반영 완료") {
    return flash("이미 정규모임에 반영된 임시모임은 수정할 수 없습니다.", "danger");
  }
  const amount = asNumber(formData.get("amount"));
  const memberId = String(formData.get("memberId") || "");
  const reason = String(formData.get("reason") || "").trim();
  if (!memberId || !reason) {
    return flash("회원과 사유는 필수입니다.", "danger");
  }
  if (!Number.isFinite(amount) || amount === 0) {
    return flash("조정 금액은 0이 아닌 숫자여야 합니다.", "danger");
  }

  state.tempMeetingAdjustments.push(
    createTempMeetingAdjustmentRecord({
      groupId: getCurrentGroupId(),
      tempMeetingId: meeting.id,
      memberId,
      amount,
      reason,
    }),
  );
  logHistory({
    entityType: "소모임",
    entityId: meeting.id,
    entityLabel: meeting.name,
    action: "수정",
    summary: `${meeting.name}에 ${getMember(memberId)?.name || "회원"} 예외 금액 ${formatSignedCurrency(amount)}을 반영했습니다.`,
  });
  persist("예외 금액을 반영했습니다.");
  form.reset();
}

function deleteGroup(id) {
  const group = state.groups.find((item) => item.id === id);
  if (!group) {
    return flash("삭제할 모임을 찾지 못했습니다.", "danger");
  }
  if (state.groups.length <= 1) {
    return flash("최소 1개의 모임은 남아 있어야 합니다.", "danger");
  }
  const hasData =
    state.members.some((item) => item.groupId === id) ||
    state.dues.some((item) => item.groupId === id) ||
    state.deposits.some((item) => item.groupId === id) ||
    state.incomeEntries.some((item) => item.groupId === id) ||
    state.expenses.some((item) => item.groupId === id) ||
    state.tempMeetings.some((item) => item.groupId === id);
  const confirmMessage = hasData
    ? `${group.name} 모임과 관련된 회원, 회비, 입금, 이자, 지출, 소모임 데이터가 모두 삭제됩니다. 계속할까요?`
    : `${group.name} 모임을 삭제할까요?`;
  if (!window.confirm(confirmMessage)) {
    return;
  }

  state.groups = state.groups.filter((item) => item.id !== id);
  state.settings.categories = state.settings.categories.filter((item) => item.groupId !== id);
  state.members = state.members.filter((item) => item.groupId !== id);
  state.dues = state.dues.filter((item) => item.groupId !== id);
  state.assignments = state.assignments.filter((item) => item.groupId !== id);
  state.deposits = state.deposits.filter((item) => item.groupId !== id);
  state.incomeEntries = state.incomeEntries.filter((item) => item.groupId !== id);
  state.expenses = state.expenses.filter((item) => item.groupId !== id);
  state.closings = state.closings.filter((item) => item.groupId !== id);
  state.history = state.history.filter((item) => item.groupId !== id);
  state.tempMeetings = state.tempMeetings.filter((item) => item.groupId !== id);
  state.tempMeetingExpenses = state.tempMeetingExpenses.filter((item) => item.groupId !== id);
  state.tempMeetingPayments = state.tempMeetingPayments.filter((item) => item.groupId !== id);
  state.tempMeetingAdjustments = state.tempMeetingAdjustments.filter((item) => item.groupId !== id);
  state.ui.selectedGroupId = state.groups[0]?.id || "";
  clearEditingState();
  syncSelectedDue();
  syncSelectedTempMeeting();
  persist(`${group.name} 모임을 삭제했습니다.`);
}

function removeTempMeeting(id) {
  const meeting = getTempMeeting(id);
  if (!meeting) {
    return flash("삭제할 임시모임을 찾지 못했습니다.", "danger");
  }
  const suffix = meeting.status === "반영 완료" ? " 정규모임에 반영된 기록은 유지됩니다." : "";
  if (!window.confirm(`${meeting.name} 임시모임을 삭제할까요?${suffix}`)) {
    return;
  }
  meeting.deletedAt = isoNow();
  getTempMeetingExpenses(meeting.id, true).forEach((item) => {
    item.deletedAt = isoNow();
  });
  getTempMeetingPayments(meeting.id, true).forEach((item) => {
    item.deletedAt = isoNow();
  });
  getTempMeetingAdjustments(meeting.id, true).forEach((item) => {
    item.deletedAt = isoNow();
  });
  logHistory({
    entityType: "소모임",
    entityId: meeting.id,
    entityLabel: meeting.name,
    action: "삭제",
    summary: `${meeting.name} 임시모임을 삭제했습니다.`,
  });
  syncSelectedTempMeeting();
  persist("임시모임을 삭제했습니다.");
}

function removeTempMeetingExpense(id) {
  const expense = state.tempMeetingExpenses.find((item) => item.id === id && item.groupId === getCurrentGroupId() && !item.deletedAt);
  if (!expense) {
    return flash("삭제할 소모임 지출을 찾지 못했습니다.", "danger");
  }
  const meeting = getTempMeeting(expense.tempMeetingId);
  if (!meeting || meeting.status === "반영 완료") {
    return flash("이미 반영된 임시모임 지출은 삭제할 수 없습니다.", "danger");
  }
  if (!window.confirm("이 소모임 지출을 삭제할까요?")) {
    return;
  }
  expense.deletedAt = isoNow();
  logHistory({
    entityType: "소모임",
    entityId: meeting.id,
    entityLabel: meeting.name,
    action: "수정",
    summary: `${meeting.name} 지출 한 건을 삭제했습니다.`,
  });
  persist("소모임 지출을 삭제했습니다.");
}

function removeTempMeetingPayment(id) {
  const payment = state.tempMeetingPayments.find((item) => item.id === id && item.groupId === getCurrentGroupId() && !item.deletedAt);
  if (!payment) {
    return flash("삭제할 소모임 납부를 찾지 못했습니다.", "danger");
  }
  const meeting = getTempMeeting(payment.tempMeetingId);
  if (!meeting || meeting.status === "반영 완료") {
    return flash("이미 반영된 임시모임 납부는 삭제할 수 없습니다.", "danger");
  }
  if (!window.confirm("이 소모임 납부를 삭제할까요?")) {
    return;
  }
  payment.deletedAt = isoNow();
  logHistory({
    entityType: "소모임",
    entityId: meeting.id,
    entityLabel: meeting.name,
    action: "수정",
    summary: `${meeting.name} 납부 한 건을 삭제했습니다.`,
  });
  persist("소모임 납부를 삭제했습니다.");
}

function removeTempMeetingAdjustment(id) {
  const adjustment = state.tempMeetingAdjustments.find(
    (item) => item.id === id && item.groupId === getCurrentGroupId() && !item.deletedAt,
  );
  if (!adjustment) {
    return flash("삭제할 예외 조정을 찾지 못했습니다.", "danger");
  }
  const meeting = getTempMeeting(adjustment.tempMeetingId);
  if (!meeting || meeting.status === "반영 완료") {
    return flash("이미 반영된 임시모임 조정은 삭제할 수 없습니다.", "danger");
  }
  if (!window.confirm("이 예외 조정을 삭제할까요?")) {
    return;
  }
  adjustment.deletedAt = isoNow();
  logHistory({
    entityType: "소모임",
    entityId: meeting.id,
    entityLabel: meeting.name,
    action: "수정",
    summary: `${meeting.name} 예외 조정 한 건을 삭제했습니다.`,
  });
  persist("예외 조정을 삭제했습니다.");
}

function reflectTempMeeting(id) {
  const meeting = getTempMeeting(id);
  if (!meeting) {
    return flash("반영할 임시모임을 찾지 못했습니다.", "danger");
  }
  if (meeting.status === "반영 완료") {
    return flash("이미 정규모임에 반영된 임시모임입니다.", "danger");
  }
  const expenses = getTempMeetingExpenses(meeting.id);
  if (!expenses.length) {
    return flash("지출이 없는 임시모임은 반영할 수 없습니다.", "danger");
  }
  const affectedPeriods = unique(
    expenses
      .map((expense) => periodOf(expense.date))
      .concat(getTempMeetingPayments(meeting.id).map((payment) => periodOf(payment.date)))
      .concat(periodOf(meeting.date)),
  );
  if (affectedPeriods.some((period) => isPeriodClosed(period))) {
    return flash("마감된 월이 포함되어 있어 임시모임 정산을 반영할 수 없습니다. 먼저 해당 월을 재오픈하세요.", "danger");
  }
  if (!window.confirm(`${meeting.name} 임시모임 정산을 현재 정규모임 기록에 반영할까요?`)) {
    return;
  }

  const settlementRows = buildTempMeetingSettlement(meeting);
  const createdDueIds = [];
  const createdDepositIds = [];
  const createdExpenseIds = [];

  expenses.forEach((expense) => {
    const createdExpense = createExpenseRecord({
      groupId: getCurrentGroupId(),
      date: expense.date,
      amount: expense.amount,
      category: expense.category,
      vendor: expense.vendor,
      purpose: `${meeting.name} · ${expense.purpose || "소모임 정산"}`,
      memo: expense.memo,
      receiptName: expense.receiptName || "",
    });
    state.expenses.push(createdExpense);
    createdExpenseIds.push(createdExpense.id);
  });

  settlementRows.forEach((row) => {
    if (row.owedAmount <= 0) {
      return;
    }
    const due = {
      id: uid("due"),
      groupId: getCurrentGroupId(),
      title: `${meeting.name} 정산 · ${row.member.name}`,
      type: "행사비",
      amount: row.owedAmount,
      period: periodOf(meeting.date),
      dueDate: meeting.date,
      targetMemberIds: [row.member.id],
      note: `${meeting.name} 임시모임 정산 반영`,
      createdAt: isoNow(),
    };
    state.dues.push(due);
    state.assignments.push(createAssignment(getCurrentGroupId(), due.id, row.member.id));
    createdDueIds.push(due.id);

    row.payments.forEach((payment) => {
      const deposit = createDepositRecord({
        groupId: getCurrentGroupId(),
        memberId: row.member.id,
        dueId: due.id,
        date: payment.date,
        amount: payment.amount,
        payerName: row.member.payerName || row.member.name,
        status: "자동",
        memo: `${meeting.name} 임시모임 납부 반영${payment.note ? ` / ${payment.note}` : ""}`,
      });
      deposit.status = resolveDepositStatus(deposit, "자동");
      state.deposits.push(deposit);
      createdDepositIds.push(deposit.id);
    });
  });

  recalculateAllAssignments(state);
  meeting.status = "반영 완료";
  meeting.reflectedAt = isoNow();
  meeting.reflectedExpenseIds = createdExpenseIds;
  meeting.reflectedDueIds = createdDueIds;
  meeting.reflectedDepositIds = createdDepositIds;
  logHistory({
    entityType: "소모임",
    entityId: meeting.id,
    entityLabel: meeting.name,
    action: "반영",
    summary: `${meeting.name} 임시모임 정산을 정규모임 지출/납부 내역에 반영했습니다.`,
  });
  persist("임시모임 정산을 정규모임 기록에 반영했습니다.");
}

function editDeposit(id) {
  const deposit = getDeposit(id);
  if (!deposit) {
    return flash("수정할 입금을 찾지 못했습니다.", "danger");
  }
  state.ui.currentTab = "deposits";
  state.ui.editing.depositId = id;
  state.ui.depositDraft = createDepositDraft({
    memberId: deposit.memberId,
    dueId: deposit.dueId,
    status: deposit.status,
  });
  renderApp();
}

function editIncomeEntry(id) {
  const entry = getIncomeEntries().find((item) => item.id === id) || null;
  if (!entry) {
    return flash("수정할 이자 수입을 찾지 못했습니다.", "danger");
  }
  state.ui.currentTab = "dashboard";
  state.ui.selectedPeriod = periodOf(entry.date);
  state.ui.editing.incomeId = id;
  renderApp();
}

function removeDeposit(id) {
  const deposit = getDeposit(id);
  if (!deposit) {
    return flash("삭제할 입금을 찾지 못했습니다.", "danger");
  }
  if (isPeriodClosed(periodOf(deposit.date))) {
    return flash("마감된 월의 입금은 삭제할 수 없습니다.", "danger");
  }
  if (!window.confirm("이 입금을 삭제할까요?")) {
    return;
  }

  deposit.deletedAt = isoNow();
  logHistory({
    entityType: "입금",
    entityId: deposit.id,
    entityLabel: deposit.payerName || "입금",
    action: "삭제",
    summary: `${deposit.payerName || "입금"} ${formatCurrency(deposit.amount)}을 삭제했습니다.`,
  });
  recalculateAllAssignments(state);
  persist("입금을 삭제했습니다.");
}

function removeIncomeEntry(id) {
  const entry = getIncomeEntries().find((item) => item.id === id) || null;
  if (!entry) {
    return flash("삭제할 이자 수입을 찾지 못했습니다.", "danger");
  }
  if (isPeriodClosed(periodOf(entry.date))) {
    return flash("마감된 월의 이자 수입은 삭제할 수 없습니다.", "danger");
  }
  if (!window.confirm("이 이자 수입을 삭제할까요?")) {
    return;
  }

  entry.deletedAt = isoNow();
  state.ui.editing.incomeId = state.ui.editing.incomeId === id ? "" : state.ui.editing.incomeId;
  logHistory({
    entityType: "수입",
    entityId: entry.id,
    entityLabel: entry.type,
    action: "삭제",
    summary: `${entry.type} ${formatCurrency(entry.amount)}을 삭제했습니다.`,
  });
  persist("이자 수입을 삭제했습니다.");
}

function removeExpense(id) {
  const expense = getExpense(id);
  if (!expense) {
    return flash("삭제할 지출을 찾지 못했습니다.", "danger");
  }
  if (isPeriodClosed(periodOf(expense.date))) {
    return flash("마감된 월의 지출은 삭제할 수 없습니다.", "danger");
  }
  if (!window.confirm("이 지출을 삭제할까요?")) {
    return;
  }
  expense.deletedAt = isoNow();
  logHistory({
    entityType: "지출",
    entityId: expense.id,
    entityLabel: expense.vendor,
    action: "삭제",
    summary: `${expense.vendor} 지출 ${formatCurrency(expense.amount)}을 삭제했습니다.`,
  });
  persist("지출을 삭제했습니다.");
}

function closePeriod(period) {
  if (isPeriodClosed(period)) {
    return flash("이미 마감된 월입니다.", "danger");
  }
  if (!Number.isFinite(getCurrentGroup()?.initialOpeningBalance)) {
    return flash("먼저 기초잔액을 설정하세요.", "danger");
  }

  const snapshot = getPeriodSnapshot(period);
  const record = {
    id: uid("close"),
    groupId: getCurrentGroupId(),
    period,
    openingBalance: snapshot.openingBalance,
    income: snapshot.income,
    expense: snapshot.expense,
    closingBalance: snapshot.closingBalance,
    status: "마감 완료",
    closedAt: isoNow(),
    reopenedAt: "",
  };

  state.closings = state.closings.filter(
    (item) => !(item.groupId === getCurrentGroupId() && item.period === period),
  );
  state.closings.push(record);
  logHistory({
    entityType: "정산",
    entityId: record.id,
    entityLabel: `${monthLabel(period)} 월 마감`,
    action: "마감",
    summary: `${monthLabel(period)}을 ${formatCurrency(record.closingBalance)} 잔액으로 마감했습니다.`,
  });
  persist(`${monthLabel(period)}을 마감했습니다.`);
}

function reopenPeriod(period) {
  const closing = getClosingRecord(period);
  if (!closing) {
    return flash("재오픈할 마감 내역이 없습니다.", "danger");
  }
  if (!window.confirm(`${monthLabel(period)}을 재오픈할까요?`)) {
    return;
  }
  closing.status = "재오픈";
  closing.reopenedAt = isoNow();
  logHistory({
    entityType: "정산",
    entityId: closing.id,
    entityLabel: `${monthLabel(period)} 월 마감`,
    action: "재오픈",
    summary: `${monthLabel(period)}을 재오픈했습니다.`,
  });
  persist(`${monthLabel(period)}을 재오픈했습니다.`);
}

function updateAssignmentStatus(id, manualStatus) {
  const assignment = state.assignments.find((item) => item.id === id);
  if (!assignment) {
    return;
  }
  const due = getDue(assignment.dueId);
  if (due && isPeriodClosed(due.period)) {
    flash("마감된 월의 납부 상태는 재오픈 전까지 바꿀 수 없습니다.", "danger");
    renderApp();
    return;
  }
  assignment.manualStatus = manualStatus;
  recalculateAssignment(state, assignment);
  const member = getMember(assignment.memberId);
  logHistory({
    entityType: "입금",
    entityId: assignment.id,
    entityLabel: `${member?.name || "회원"} / ${due?.title || "회비"}`,
    action: "수정",
    summary: `${member?.name || "회원"} 상태를 ${assignment.status}로 변경했습니다.`,
  });
  persist("납부 상태를 변경했습니다.");
}

function toggleCategory(id) {
  const category = getCategories().find((item) => item.id === id);
  if (!category) {
    return;
  }
  category.active = !category.active;
  logHistory({
    entityType: "설정",
    entityId: category.id,
    entityLabel: category.name,
    action: "수정",
    summary: `${category.name} 카테고리를 ${category.active ? "활성화" : "비활성화"}했습니다.`,
  });
  persist(`카테고리를 ${category.active ? "활성화" : "비활성화"}했습니다.`);
}

function exportState() {
  const group = getCurrentGroup();
  downloadFile(
    `moim-treasurer-board-${safeSlug(group?.name || "group")}-${state.ui.selectedPeriod}.json`,
    JSON.stringify(exportCurrentGroupState(), null, 2),
    "application/json",
  );
  flash("현재 상태를 JSON으로 내보냈습니다.");
  renderApp();
}

function exportFullBackup() {
  const payload = createFullBackupPayload();
  const fileName = `moim-treasurer-backup-${compactTimestamp(payload.exportedAt)}.json`;
  downloadFile(fileName, JSON.stringify(payload, null, 2), "application/json");
  flash("전체 데이터 백업 파일을 저장했습니다.");
  renderApp();
}

async function shareFullBackup() {
  const payload = createFullBackupPayload();
  const fileName = `moim-treasurer-backup-${compactTimestamp(payload.exportedAt)}.json`;
  const content = JSON.stringify(payload, null, 2);
  const file = new File([content], fileName, { type: "application/json" });

  try {
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      await navigator.share({
        title: "모임 총무 보드 백업",
        text: "총무 운영 데이터를 백업 파일로 전달합니다.",
        files: [file],
      });
      flash("백업 파일 공유 창을 열었습니다.");
    } else {
      downloadFile(fileName, content, "application/json");
      flash("공유를 지원하지 않아 백업 파일로 저장했습니다.");
    }
  } catch (error) {
    if (error?.name === "AbortError") {
      flash("백업 파일 공유를 취소했습니다.", "danger");
    } else {
      console.error(error);
      downloadFile(fileName, content, "application/json");
      flash("공유 중 문제가 있어 백업 파일로 저장했습니다.", "danger");
    }
  }

  renderApp();
}

function triggerBackupImport() {
  document.getElementById("backup-import-input")?.click();
}

async function importBackupFile(file, input) {
  try {
    const raw = await file.text();
    const payload = JSON.parse(raw);

    if (!isValidBackupPayload(payload)) {
      flash("이 파일은 전체 데이터 백업 형식이 아닙니다. `전체 데이터 백업` 파일을 선택하세요.", "danger");
      renderApp();
      return;
    }

    if (!window.confirm("현재 기기 데이터를 이 백업 파일로 교체할까요?")) {
      return;
    }

    restoreBackupPayload(payload);
    saveState();
    flash("백업 파일로 전체 데이터를 복원했습니다.");
    renderApp();
  } catch (error) {
    console.error(error);
    flash("백업 파일을 읽지 못했습니다. JSON 파일인지 확인하세요.", "danger");
    renderApp();
  } finally {
    if (input) {
      input.value = "";
    }
  }
}

function exportPeriodSummary() {
  const snapshot = getPeriodSnapshot(state.ui.selectedPeriod);
  const group = getCurrentGroup();
  const lines = [
    `모임: ${group?.name || "-"}`,
    `기간: ${monthLabel(state.ui.selectedPeriod)}`,
    `기초잔액: ${formatCurrency(snapshot.openingBalance)}`,
    `회비 입금: ${formatCurrency(snapshot.depositIncome)}`,
    `이자 수입: ${formatCurrency(snapshot.interestIncome)}`,
    `확정 수입: ${formatCurrency(snapshot.income)}`,
    `지출: ${formatCurrency(snapshot.expense)}`,
    `기말잔액: ${formatCurrency(snapshot.closingBalance)}`,
    `미납/부분 납부: ${snapshot.unpaidCount}명`,
    `검토 필요 입금: ${snapshot.reviewCount}건`,
  ];
  downloadFile(
    `closing-summary-${safeSlug(group?.name || "group")}-${state.ui.selectedPeriod}.txt`,
    lines.join("\n"),
    "text/plain;charset=utf-8",
  );
  flash("정산 요약 파일을 내보냈습니다.");
  renderApp();
}

function resetDemo() {
  if (!window.confirm("샘플 데이터를 다시 불러오고 현재 변경 내용을 지울까요?")) {
    return;
  }
  const fresh = createSeedState();
  Object.keys(state).forEach((key) => delete state[key]);
  Object.assign(state, fresh);
  saveState();
  renderApp();
}

function persist(message) {
  saveState();
  flash(message);
  renderApp();
}

function flash(message, type = "info") {
  state.ui.flash = { message, type };
}

function logHistory(entry) {
  state.history.unshift(createHistoryEntry(entry));
}

function createHistoryEntry(entry) {
  return {
    id: uid("hist"),
    groupId: entry.groupId || getCurrentGroupId() || "",
    entityType: entry.entityType,
    entityId: entry.entityId,
    entityLabel: entry.entityLabel,
    action: entry.action,
    summary: entry.summary,
    actor: entry.actor || "총무",
    at: entry.at || isoNow(),
  };
}

function createAssignment(groupId, dueId, memberId) {
  return {
    id: uid("assign"),
    groupId,
    dueId,
    memberId,
    status: "미납",
    manualStatus: "자동",
    paidAmount: 0,
    paidAt: "",
    depositIds: [],
    memo: "",
  };
}

function createDepositRecord(payload) {
  return {
    id: uid("deposit"),
    groupId: payload.groupId || getCurrentGroupId() || "",
    memberId: payload.memberId || "",
    dueId: payload.dueId || "",
    date: payload.date,
    amount: asNumber(payload.amount),
    payerName: payload.payerName || "",
    status: payload.status || "확인 필요",
    memo: payload.memo || "",
    deletedAt: "",
  };
}

function createIncomeEntryRecord(payload) {
  return {
    id: uid("income"),
    groupId: payload.groupId || getCurrentGroupId() || "",
    date: payload.date || today(),
    amount: asNumber(payload.amount),
    type: payload.type || "이자",
    note: payload.note || "",
    deletedAt: payload.deletedAt || "",
  };
}

function createExpenseRecord(payload) {
  return {
    id: uid("expense"),
    groupId: payload.groupId || getCurrentGroupId() || "",
    date: payload.date,
    amount: asNumber(payload.amount),
    category: payload.category || "기타",
    vendor: payload.vendor || "",
    purpose: payload.purpose || "",
    memo: payload.memo || "",
    receiptName: payload.receiptName || "",
    deletedAt: "",
  };
}

function createTempMeetingRecord(payload) {
  return {
    id: uid("temp"),
    groupId: payload.groupId || getCurrentGroupId() || "",
    name: payload.name || "",
    date: payload.date || today(),
    participantIds: unique((payload.participantIds || []).filter(Boolean)),
    note: payload.note || "",
    status: payload.status || "진행 중",
    reflectedAt: payload.reflectedAt || "",
    reflectedExpenseIds: payload.reflectedExpenseIds || [],
    reflectedDueIds: payload.reflectedDueIds || [],
    reflectedDepositIds: payload.reflectedDepositIds || [],
    createdAt: payload.createdAt || isoNow(),
    deletedAt: payload.deletedAt || "",
  };
}

function createTempMeetingExpenseRecord(payload) {
  return {
    id: uid("temp-exp"),
    groupId: payload.groupId || getCurrentGroupId() || "",
    tempMeetingId: payload.tempMeetingId || "",
    date: payload.date || today(),
    amount: asNumber(payload.amount),
    category: payload.category || "기타",
    vendor: payload.vendor || "",
    purpose: payload.purpose || "",
    memo: payload.memo || "",
    receiptName: payload.receiptName || "",
    participantIds: unique((payload.participantIds || []).filter(Boolean)),
    createdAt: payload.createdAt || isoNow(),
    deletedAt: payload.deletedAt || "",
  };
}

function createTempMeetingPaymentRecord(payload) {
  return {
    id: uid("temp-pay"),
    groupId: payload.groupId || getCurrentGroupId() || "",
    tempMeetingId: payload.tempMeetingId || "",
    memberId: payload.memberId || "",
    date: payload.date || today(),
    amount: asNumber(payload.amount),
    note: payload.note || "",
    createdAt: payload.createdAt || isoNow(),
    deletedAt: payload.deletedAt || "",
  };
}

function createTempMeetingAdjustmentRecord(payload) {
  return {
    id: uid("temp-adj"),
    groupId: payload.groupId || getCurrentGroupId() || "",
    tempMeetingId: payload.tempMeetingId || "",
    memberId: payload.memberId || "",
    amount: asNumber(payload.amount),
    reason: payload.reason || "",
    createdAt: payload.createdAt || isoNow(),
    deletedAt: payload.deletedAt || "",
  };
}

function recalculateAllAssignments(targetState) {
  targetState.assignments.forEach((assignment) => recalculateAssignment(targetState, assignment));
}

function recalculateAssignment(targetState, assignment) {
  const due = targetState.dues.find(
    (item) => item.id === assignment.dueId && item.groupId === assignment.groupId,
  );
  const deposits = targetState.deposits.filter(
    (deposit) =>
      !deposit.deletedAt &&
      deposit.groupId === assignment.groupId &&
      deposit.memberId === assignment.memberId &&
      deposit.dueId === assignment.dueId,
  );

  assignment.depositIds = deposits.map((deposit) => deposit.id);
  assignment.paidAmount = deposits.reduce((sum, deposit) => sum + asNumber(deposit.amount), 0);
  assignment.paidAt = deposits
    .map((deposit) => deposit.date)
    .sort((left, right) => left.localeCompare(right))
    .pop() || "";

  if (assignment.manualStatus && assignment.manualStatus !== "자동") {
    assignment.status = assignment.manualStatus;
    return;
  }

  if (!due) {
    assignment.status = "확인 필요";
    return;
  }

  assignment.status = suggestStatus(assignment.paidAmount, due.amount);
}

function suggestStatus(paidAmount, dueAmount) {
  if (!paidAmount) {
    return "미납";
  }
  if (paidAmount === dueAmount) {
    return "납부 완료";
  }
  if (paidAmount > 0 && paidAmount < dueAmount) {
    return "부분 납부";
  }
  return "확인 필요";
}

function resolveDepositStatus(record, chosenStatus) {
  if (chosenStatus === "부분 납부") {
    return "부분 납부";
  }
  if (chosenStatus === "확인 필요") {
    return "확인 필요";
  }
  return "납부 완료";
}

function getDueCounts(dueId) {
  const items = getAssignments().filter((assignment) => assignment.dueId === dueId);
  return {
    paidCount: items.filter((item) => item.status === "납부 완료").length,
    partialCount: items.filter((item) => item.status === "부분 납부").length,
    unpaidOnlyCount: items.filter((item) => item.status === "미납").length,
    reviewCount: items.filter((item) => item.status === "확인 필요").length,
    exemptCount: items.filter((item) => item.status === "면제").length,
  };
}

function getAllDueCounts(period) {
  const assignments = getAssignmentsForPeriod(period);
  return {
    totalDueCount: getDuesForPeriod(period).length,
    paidCount: assignments.filter((item) => item.status === "납부 완료").length,
    partialCount: assignments.filter((item) => item.status === "부분 납부").length,
    unpaidOnlyCount: assignments.filter((item) => item.status === "미납").length,
    reviewAssignmentCount: assignments.filter((item) => item.status === "확인 필요").length,
    exemptCount: assignments.filter((item) => item.status === "면제").length,
  };
}

function getPeriodSnapshot(period) {
  const openingBalance = getOpeningBalance(period);
  const deposits = getDepositsForPeriod(period).filter((deposit) =>
    CONFIRMED_PAYMENT_STATUSES.has(deposit.status),
  );
  const incomeEntries = getIncomeEntriesForPeriod(period);
  const expenses = getExpensesForPeriod(period);
  const assignments = getAssignmentsForPeriod(period);
  const depositIncome = deposits.reduce((sum, deposit) => sum + asNumber(deposit.amount), 0);
  const extraIncome = incomeEntries.reduce((sum, entry) => sum + asNumber(entry.amount), 0);
  const expenseTotal = expenses.reduce((sum, expense) => sum + asNumber(expense.amount), 0);
  return {
    openingBalance,
    depositIncome,
    interestIncome: extraIncome,
    income: depositIncome + extraIncome,
    expense: expenseTotal,
    closingBalance: openingBalance + depositIncome + extraIncome - expenseTotal,
    unpaidCount: assignments.filter(
      (assignment) => !["납부 완료", "면제"].includes(assignment.status),
    ).length,
    reviewCount: getDepositsForPeriod(period).filter((deposit) => deposit.status === "확인 필요").length,
  };
}

function getOpeningBalance(period) {
  const currentClosing = getClosingRecord(period);
  if (currentClosing) {
    return asNumber(currentClosing.openingBalance);
  }

  const previousClosings = getClosings()
    .filter((item) => item.status === "마감 완료" && item.period < period)
    .sort((left, right) => right.period.localeCompare(left.period));

  if (previousClosings.length) {
    return asNumber(previousClosings[0].closingBalance);
  }

  return asNumber(getCurrentGroup()?.initialOpeningBalance);
}

function getClosingRecord(period) {
  return (
    getClosings().find(
      (item) => item.period === period && item.status === "마감 완료" && !item.reopenedAt,
    ) ||
    null
  );
}

function isPeriodClosed(period) {
  return Boolean(getClosingRecord(period));
}

function getDuesForPeriod(period) {
  return getDues().filter((due) => due.period === period);
}

function getDepositDueOptions(memberId = "") {
  const dues = getDues()
    .filter((due) => !memberId || due.targetMemberIds.includes(memberId))
    .slice()
    .sort((left, right) => {
      const rightKey = `${right.period}${right.dueDate || ""}${right.createdAt || ""}`;
      const leftKey = `${left.period}${left.dueDate || ""}${left.createdAt || ""}`;
      return rightKey.localeCompare(leftKey);
    });

  return dues.length
    ? dues
    : getDues()
        .slice()
        .sort((left, right) => {
          const rightKey = `${right.period}${right.dueDate || ""}${right.createdAt || ""}`;
          const leftKey = `${left.period}${left.dueDate || ""}${left.createdAt || ""}`;
          return rightKey.localeCompare(leftKey);
        });
}

function getAssignmentsForPeriod(period) {
  const dueIds = new Set(getDuesForPeriod(period).map((due) => due.id));
  return getAssignments().filter((assignment) => dueIds.has(assignment.dueId));
}

function getDepositsForPeriod(period) {
  return getDeposits().filter((deposit) => !deposit.deletedAt && periodOf(deposit.date) === period);
}

function getIncomeEntriesForPeriod(period) {
  return getIncomeEntries().filter((entry) => !entry.deletedAt && periodOf(entry.date) === period);
}

function getExpensesForPeriod(period) {
  return getExpenses().filter((expense) => !expense.deletedAt && periodOf(expense.date) === period);
}

function filterMembers(filters) {
  const query = filters.memberQuery.trim().toLowerCase();
  return getMembers().filter((member) => {
    const matchesQuery =
      !query ||
      [member.name, member.nickname, member.payerName, member.contact, member.joinDate]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(query));
    const matchesStatus = filters.memberStatus === "all" || member.status === filters.memberStatus;
    const matchesEligibility =
      filters.memberEligibility === "all" ||
      (filters.memberEligibility === "yes" && member.duesEligible) ||
      (filters.memberEligibility === "no" && !member.duesEligible);
    return matchesQuery && matchesStatus && matchesEligibility;
  });
}

function filterAssignmentsForSelectedDue(dueId) {
  if (!dueId) {
    return [];
  }
  const statusFilter = state.ui.filters.dueAssignmentStatus;
  return getAssignments().filter((assignment) => {
    if (assignment.dueId !== dueId) {
      return false;
    }
    if (statusFilter === "all") {
      return true;
    }
    return assignment.status === statusFilter;
  });
}

function filterDeposits(filters) {
  return getDepositsForPeriod(state.ui.selectedPeriod).filter((deposit) => {
    if (filters.depositStatus === "all") {
      return true;
    }
    return deposit.status === filters.depositStatus;
  });
}

function filterExpenses(filters) {
  const query = filters.expenseQuery.trim().toLowerCase();
  return getExpensesForPeriod(state.ui.selectedPeriod).filter((expense) => {
    const matchesQuery =
      !query ||
      [expense.vendor, expense.memo, expense.purpose]
        .filter(Boolean)
        .some((value) => value.toLowerCase().includes(query));
    const matchesCategory =
      filters.expenseCategory === "all" || expense.category === filters.expenseCategory;
    return matchesQuery && matchesCategory;
  });
}

function filterHistory() {
  return getHistory().filter((item) => {
    const typeMatches =
      state.ui.filters.historyType === "all" || item.entityType === state.ui.filters.historyType;
    const actionMatches =
      state.ui.filters.historyAction === "all" || item.action === state.ui.filters.historyAction;
    return typeMatches && actionMatches;
  });
}

function mergeLedgerRows(period) {
  const incomeRows = getDepositsForPeriod(period).map((deposit) => ({
    date: deposit.date,
    kind: "수입",
    label: `${getMember(deposit.memberId)?.name || "미지정"} / ${getDue(deposit.dueId)?.title || "회비 미지정"}`,
    status: deposit.status,
    amount: deposit.amount,
  }));
  const extraIncomeRows = getIncomeEntriesForPeriod(period).map((entry) => ({
    date: entry.date,
    kind: "이자",
    label: `${entry.type}${entry.note ? ` / ${entry.note}` : ""}`,
    status: "반영 완료",
    amount: entry.amount,
  }));
  const expenseRows = getExpensesForPeriod(period).map((expense) => ({
    date: expense.date,
    kind: "지출",
    label: `${expense.vendor} / ${expense.category}`,
    status: expense.receiptName ? "증빙 있음" : "증빙 없음",
    amount: expense.amount,
  }));
  return [...incomeRows, ...extraIncomeRows, ...expenseRows].sort((left, right) => right.date.localeCompare(left.date));
}

function getSelectedYear() {
  return String(state.ui.selectedPeriod || currentPeriod()).slice(0, 4);
}

function getAvailablePeriods(selectedPeriod) {
  const anchor = selectedPeriod || currentPeriod();
  const periods = [];
  for (let offset = -18; offset <= 18; offset += 1) {
    periods.push(shiftPeriod(anchor, offset));
  }
  return unique(periods);
}

function getYearMonthPeriods(year) {
  return YEAR_MONTH_LABELS.map((label, index) => ({
    label,
    period: `${year}-${pad(index + 1)}`,
  }));
}

function primaryMonthlyDuesFor(dues) {
  return dues.filter((due) => due.type === "월회비");
}

function getFallbackRegularMonthlyFee(dues) {
  return dues
    .slice()
    .sort((left, right) => right.period.localeCompare(left.period))
    .map((due) => asNumber(due.amount))
    .find((amount) => amount > 0) || 0;
}

function getAnnualMembershipCell(member, period) {
  const joinPeriod = periodOf(member.joinDate);
  const regularMonthlyFee = asNumber(getCurrentGroup()?.regularMonthlyFee);
  const obligationCutoff = state.ui.selectedPeriod < currentPeriod() ? state.ui.selectedPeriod : currentPeriod();
  if (joinPeriod && period < joinPeriod) {
    return {
      code: "before-join",
      label: "가입 전",
      detail: member.joinDate,
      dueAmount: 0,
      paidAmount: 0,
      title: `${monthLabel(period)}은 가입 전이어서 납부 의무가 없습니다.`,
    };
  }

  const dues = getDuesForPeriod(period).filter((due) => due.type === "월회비");
  if (!dues.length) {
    const isFuture = period > obligationCutoff;
    if (regularMonthlyFee > 0 && !isFuture) {
      return {
        code: "unpaid",
        label: "미납",
        detail: formatCurrency(regularMonthlyFee),
        dueAmount: regularMonthlyFee,
        paidAmount: 0,
        title: `${monthLabel(period)} 월회비 기준금액 ${formatCurrency(regularMonthlyFee)}이 설정되어 있지만 납부 내역이 없습니다.`,
      };
    }
    return {
      code: isFuture ? "scheduled" : "missing",
      label: isFuture ? "예정" : "미생성",
      detail: regularMonthlyFee > 0 ? formatCurrency(regularMonthlyFee) : isFuture ? "등록 전" : "회비 없음",
      dueAmount: 0,
      paidAmount: 0,
      title: isFuture
        ? `${monthLabel(period)} 월회비는 아직 도래하지 않았습니다.`
        : `${monthLabel(period)} 월회비 항목이 아직 생성되지 않았습니다.`,
    };
  }

  const memberDues = dues.filter((due) => due.targetMemberIds.includes(member.id));
  if (!memberDues.length) {
    return {
      code: "not-target",
      label: "대상 아님",
      detail: "-",
      dueAmount: 0,
      paidAmount: 0,
      title: `${monthLabel(period)} 월회비 대상에 포함되지 않았습니다.`,
    };
  }

  const assignments = memberDues
    .map((due) => getAssignments().find((assignment) => assignment.dueId === due.id && assignment.memberId === member.id))
    .filter(Boolean);
  const dueAmount = memberDues.reduce((sum, due) => sum + asNumber(due.amount), 0);
  const paidAmount = assignments.reduce((sum, assignment) => sum + asNumber(assignment.paidAmount), 0);
  const latestPaidAt =
    assignments
      .map((assignment) => assignment.paidAt)
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))
      .pop() || "";

  if (assignments.some((assignment) => assignment.status === "확인 필요")) {
    return {
      code: "review",
      label: "검토",
      detail: paidAmount ? formatCurrency(paidAmount) : "대조 필요",
      dueAmount,
      paidAmount,
      title: `${monthLabel(period)} 입금 중 확인 필요 상태가 있어 총무 검토가 필요합니다.`,
    };
  }

  if (assignments.length && assignments.every((assignment) => assignment.status === "면제")) {
    return {
      code: "exempt",
      label: "면제",
      detail: formatCurrency(dueAmount),
      dueAmount: 0,
      paidAmount: 0,
      title: `${monthLabel(period)} 월회비는 면제로 처리되었습니다.`,
    };
  }

  if (paidAmount >= dueAmount && dueAmount > 0) {
    return {
      code: "paid",
      label: "완납",
      detail: latestPaidAt ? formatMonthDay(latestPaidAt) : formatCurrency(paidAmount),
      dueAmount,
      paidAmount,
      title: `${monthLabel(period)} 월회비 ${formatCurrency(dueAmount)} 완납${
        latestPaidAt ? ` / 최근 입금 ${latestPaidAt}` : ""
      }`,
    };
  }

  if (paidAmount > 0) {
    return {
      code: "partial",
      label: "부분",
      detail: `${formatCurrency(paidAmount)}/${formatCurrency(dueAmount)}`,
      dueAmount,
      paidAmount,
      title: `${monthLabel(period)} 월회비 ${formatCurrency(dueAmount)} 중 ${formatCurrency(paidAmount)} 납부`,
    };
  }

  return {
    code: "unpaid",
    label: "미납",
    detail: formatCurrency(dueAmount),
    dueAmount,
    paidAmount: 0,
    title: `${monthLabel(period)} 월회비 ${formatCurrency(dueAmount)} 미납 상태입니다.`,
  };
}

function getTempMeetingSnapshot(meeting) {
  const settlement = buildTempMeetingSettlement(meeting);
  return {
    expenseTotal: getTempMeetingExpenses(meeting.id).reduce((sum, expense) => sum + asNumber(expense.amount), 0),
    paymentTotal: getTempMeetingPayments(meeting.id).reduce((sum, payment) => sum + asNumber(payment.amount), 0),
    balanceTotal: settlement.reduce((sum, row) => sum + row.balance, 0),
  };
}

function buildTempMeetingSettlement(meeting) {
  const rows = meeting.participantIds
    .map((memberId) => getMember(memberId))
    .filter(Boolean)
    .map((member) => ({
      member,
      baseAmount: 0,
      adjustmentAmount: 0,
      owedAmount: 0,
      paidAmount: 0,
      balance: 0,
      payments: [],
    }));
  const rowMap = new Map(rows.map((row) => [row.member.id, row]));

  getTempMeetingExpenses(meeting.id).forEach((expense) => {
    splitAmountAcrossMembers(expense.amount, expense.participantIds).forEach((allocation) => {
      const row = rowMap.get(allocation.memberId);
      if (row) {
        row.baseAmount += allocation.amount;
      }
    });
  });

  getTempMeetingAdjustments(meeting.id).forEach((adjustment) => {
    const row = rowMap.get(adjustment.memberId);
    if (row) {
      row.adjustmentAmount += asNumber(adjustment.amount);
    }
  });

  getTempMeetingPayments(meeting.id).forEach((payment) => {
    const row = rowMap.get(payment.memberId);
    if (row) {
      row.paidAmount += asNumber(payment.amount);
      row.payments.push(payment);
    }
  });

  rows.forEach((row) => {
    row.owedAmount = Math.max(0, row.baseAmount + row.adjustmentAmount);
    row.balance = row.owedAmount - row.paidAmount;
  });

  return rows.sort((left, right) => left.member.name.localeCompare(right.member.name, "ko-KR"));
}

function splitAmountAcrossMembers(amount, memberIds) {
  const targets = unique((memberIds || []).filter(Boolean));
  if (!targets.length) {
    return [];
  }
  const total = asNumber(amount);
  const base = Math.floor(total / targets.length);
  let remainder = total - base * targets.length;
  return targets.map((memberId) => {
    const share = base + (remainder > 0 ? 1 : 0);
    remainder = Math.max(0, remainder - 1);
    return { memberId, amount: share };
  });
}

function findOrCreateAssignment(dueId, memberId) {
  let assignment = getAssignments().find(
    (item) => item.dueId === dueId && item.memberId === memberId,
  );
  if (!assignment) {
    assignment = createAssignment(getCurrentGroupId(), dueId, memberId);
    state.assignments.push(assignment);
  }
  return assignment;
}

function getCurrentGroupId() {
  return state.ui?.selectedGroupId || state.groups?.[0]?.id || "";
}

function getCurrentGroup() {
  return state.groups.find((group) => group.id === getCurrentGroupId()) || null;
}

function getGroups() {
  return state.groups.slice();
}

function getTempMeetings(includeDeleted = false) {
  return state.tempMeetings.filter(
    (meeting) => meeting.groupId === getCurrentGroupId() && (includeDeleted || !meeting.deletedAt),
  );
}

function getTempMeeting(id) {
  return getTempMeetings(true).find((meeting) => meeting.id === id) || null;
}

function getSelectedTempMeeting() {
  return getTempMeeting(state.ui.selectedTempMeetingId);
}

function getTempMeetingExpenses(tempMeetingId, includeDeleted = false) {
  return state.tempMeetingExpenses.filter(
    (expense) =>
      expense.groupId === getCurrentGroupId() &&
      expense.tempMeetingId === tempMeetingId &&
      (includeDeleted || !expense.deletedAt),
  );
}

function getTempMeetingPayments(tempMeetingId, includeDeleted = false) {
  return state.tempMeetingPayments.filter(
    (payment) =>
      payment.groupId === getCurrentGroupId() &&
      payment.tempMeetingId === tempMeetingId &&
      (includeDeleted || !payment.deletedAt),
  );
}

function getTempMeetingAdjustments(tempMeetingId, includeDeleted = false) {
  return state.tempMeetingAdjustments.filter(
    (adjustment) =>
      adjustment.groupId === getCurrentGroupId() &&
      adjustment.tempMeetingId === tempMeetingId &&
      (includeDeleted || !adjustment.deletedAt),
  );
}

function getCategories() {
  return state.settings.categories.filter((category) => category.groupId === getCurrentGroupId());
}

function getMembers() {
  return state.members.filter((member) => member.groupId === getCurrentGroupId());
}

function getDues() {
  return state.dues.filter((due) => due.groupId === getCurrentGroupId());
}

function getAssignments() {
  return state.assignments.filter((assignment) => assignment.groupId === getCurrentGroupId());
}

function getDeposits() {
  return state.deposits.filter((deposit) => deposit.groupId === getCurrentGroupId());
}

function getIncomeEntries() {
  return state.incomeEntries.filter((entry) => entry.groupId === getCurrentGroupId());
}

function getExpenses() {
  return state.expenses.filter((expense) => expense.groupId === getCurrentGroupId());
}

function getClosings() {
  return state.closings.filter((closing) => closing.groupId === getCurrentGroupId());
}

function getHistory() {
  return state.history.filter((item) => item.groupId === getCurrentGroupId());
}

function clearEditingState() {
  state.ui.editing = {
    memberId: "",
    dueId: "",
    depositId: "",
    incomeId: "",
    expenseId: "",
  };
  state.ui.depositDraft = createDepositDraft();
  state.ui.selectedTempMeetingId = "";
}

function exportCurrentGroupState() {
  const groupId = getCurrentGroupId();
  return {
    group: getCurrentGroup(),
    categories: state.settings.categories.filter((category) => category.groupId === groupId),
    members: state.members.filter((member) => member.groupId === groupId),
    dues: state.dues.filter((due) => due.groupId === groupId),
    assignments: state.assignments.filter((assignment) => assignment.groupId === groupId),
    deposits: state.deposits.filter((deposit) => deposit.groupId === groupId),
    incomeEntries: state.incomeEntries.filter((entry) => entry.groupId === groupId),
    expenses: state.expenses.filter((expense) => expense.groupId === groupId),
    closings: state.closings.filter((closing) => closing.groupId === groupId),
    history: state.history.filter((item) => item.groupId === groupId),
    tempMeetings: state.tempMeetings.filter((meeting) => meeting.groupId === groupId),
    tempMeetingExpenses: state.tempMeetingExpenses.filter((expense) => expense.groupId === groupId),
    tempMeetingPayments: state.tempMeetingPayments.filter((payment) => payment.groupId === groupId),
    tempMeetingAdjustments: state.tempMeetingAdjustments.filter((adjustment) => adjustment.groupId === groupId),
  };
}

function createFullBackupPayload() {
  return {
    kind: "moim-treasurer-backup",
    version: 1,
    exportedAt: isoNow(),
    origin: window.location.origin,
    data: getSharedStateSnapshot(),
    uiContext: {
      selectedGroupId: state.ui.selectedGroupId || "",
      selectedPeriod: state.ui.selectedPeriod || currentPeriod(),
    },
  };
}

function isValidBackupPayload(payload) {
  return (
    payload &&
    payload.kind === "moim-treasurer-backup" &&
    typeof payload.version === "number" &&
    payload.data &&
    typeof payload.data === "object" &&
    Array.isArray(payload.data.groups)
  );
}

function restoreBackupPayload(payload) {
  applySharedState(payload.data);
  clearEditingState();
  state.ui.currentTab = "dashboard";
  state.ui.selectedGroupId =
    payload.uiContext?.selectedGroupId &&
    state.groups.some((group) => group.id === payload.uiContext.selectedGroupId)
      ? payload.uiContext.selectedGroupId
      : state.groups[0]?.id || "";
  state.ui.selectedPeriod = /^\d{4}-\d{2}$/.test(payload.uiContext?.selectedPeriod || "")
    ? payload.uiContext.selectedPeriod
    : currentPeriod();
  syncSelectedDue();
  syncSelectedTempMeeting();
}

function getMember(id) {
  return getMembers().find((member) => member.id === id) || null;
}

function getDue(id) {
  return getDues().find((due) => due.id === id) || null;
}

function getDeposit(id) {
  return getDeposits().find((deposit) => deposit.id === id) || null;
}

function getExpense(id) {
  return getExpenses().find((expense) => expense.id === id) || null;
}

function getActiveCategories() {
  return getCategories().filter((category) => category.active);
}

function isEligibleMember(member) {
  return member.duesEligible && member.status === "활성";
}

function sortDateDesc(items) {
  return items.slice().sort((left, right) => {
    const rightKey = `${right.date || ""}${right.createdAt || ""}`;
    const leftKey = `${left.date || ""}${left.createdAt || ""}`;
    return rightKey.localeCompare(leftKey);
  });
}

function periodOf(date) {
  return String(date || "").slice(0, 7);
}

function shiftPeriod(period, delta) {
  const [year, month] = period.split("-").map(Number);
  const shifted = new Date(year, month - 1 + delta, 1);
  return `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}`;
}

function dateInPeriod(period, day) {
  return `${period}-${pad(day)}`;
}

function currentPeriod() {
  const date = new Date();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

function today() {
  const date = new Date();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isoNow() {
  return new Date().toISOString();
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function uid(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36).slice(-4)}`;
}

function asNumber(value) {
  return Number(value || 0);
}

function unique(items) {
  return Array.from(new Set(items));
}

function safeSlug(value) {
  return String(value || "group")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "") || "group";
}

function monthLabel(period) {
  const [year, month] = String(period).split("-");
  return `${year}년 ${month}월`;
}

function formatCurrency(value) {
  return `${new Intl.NumberFormat("ko-KR").format(asNumber(value))}원`;
}

function formatSignedCurrency(value) {
  const amount = asNumber(value);
  if (amount > 0) {
    return `+${formatCurrency(amount)}`;
  }
  if (amount < 0) {
    return `-${formatCurrency(Math.abs(amount))}`;
  }
  return formatCurrency(0);
}

function scrollPageTop() {
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function formatDate(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(`${value}T00:00:00`);
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatMonthDay(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
  })
    .format(date)
    .replace(/\.\s?/g, ".")
    .replace(/\.$/, "");
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  return new Intl.DateTimeFormat("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function compactTimestamp(value) {
  const date = new Date(value || isoNow());
  if (Number.isNaN(date.getTime())) {
    return currentPeriod();
  }
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeDateValue(value) {
  const normalized = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : "";
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
