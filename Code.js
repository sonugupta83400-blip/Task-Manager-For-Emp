/**********************************************************************
 *  EMPLOYEE TASK MANAGEMENT SYSTEM — Full Merge
 *  --------------------------------------------------------------
 *  Combines:
 *   1) Real login via a "Users" tab in a central Google Sheet
 *   2) A polished task dashboard (table/board/chart, add/update/delete)
 *      backed by each employee's OWN task spreadsheet (SHEETS_CONFIG)
 *   3) "My Sheets" + automatic "Pending & Overdue Work" scanning across
 *      any other personal sheets an employee has (Checklist, FMS,
 *      Sales Report, etc) via a "SheetLinks" tab
 *   4) Admin view: pick an employee from a list, then drill into
 *      that employee's tasks + personal sheets only
 *   5) In-portal + BROWSER notifications: whenever an Admin assigns a
 *      task, the responsible employee sees a bell-icon notification
 *      AND a real OS-level browser popup the next time they poll —
 *      Admin/Manager accounts ALSO get a broadcast notification (and
 *      browser popup) for every task assigned to ANY employee, so
 *      they don't have to babysit each employee's sheet.
 *   6) Due-soon reminders: any task due TODAY or TOMORROW fires an
 *      in-portal + browser notification. Employees get this for their
 *      own tasks; Admin/Manager get it for EVERY employee's tasks.
 *
 *  ===================== NEW IN THIS VERSION =====================
 *  BROWSER NOTIFICATIONS FOR ADMIN/MANAGER (all-employee visibility)
 *  ------------------------------------------------------------------
 *  Previously the "Notifications" tab only ever stored rows keyed by
 *  an employee's personKey, and getMyNotifications()/markNotificationsRead()
 *  only had a code path for a logged-in employee (session.personKey).
 *  Admin/Manager accounts have NO personKey of their own, so they
 *  always got back an empty notification list — even though they're
 *  the ones assigning tasks and most need the "due soon" alerts.
 *
 *  Fix: added ADMIN_BROADCAST_KEY, a synthetic PersonKey value used
 *  ONLY for notifications meant for every Admin/Manager account (never
 *  a real employee — SHEETS_CONFIG never has a key matching it, so it
 *  can't collide). Every place that creates or reads notifications now
 *  branches on isAdminRole_(session.role):
 *    - addTaskToPerson() now ALSO writes a broadcast row (in addition
 *      to the existing employee-scoped row) whenever a task is assigned.
 *    - checkDueSoonAndNotify() now, for Admin/Manager, loops every
 *      person in SHEETS_CONFIG and writes a broadcast row for each
 *      task due today/tomorrow (prefixed with the employee's name so
 *      it's clear whose task it is) — for a regular employee, behavior
 *      is unchanged (their own tasks only).
 *    - getMyNotifications() / markNotificationsRead() now read/write
 *      the ADMIN_BROADCAST_KEY scope for Admin/Manager instead of
 *      always returning empty.
 *
 *  Note: because the broadcast feed is ONE shared set of rows, marking
 *  a broadcast notification "read" as one Admin marks it read for every
 *  Admin/Manager account (there's no per-admin-account row). That's
 *  intentional for a small team; say the word if you'd rather each
 *  admin account track its own read/unread state and I'll split it out
 *  by username instead of by role.
 *
 *  The client (Index.html) now also requests OS notification permission
 *  on login and fires a real `new Notification(...)` browser popup for
 *  every notification it hasn't already shown, in addition to the
 *  existing in-portal bell icon.
 *
 *  ===================== PREVIOUS FIXES (kept) =====================
 *  1) SHEETS_CONFIG['person5'] (Harish) had gone blank — restored.
 *  2) getAllTasks() no longer caches a PARTIAL result; retries increased
 *     from 3 to 5; rebuild lock wait increased from 10s to 20s.
 *  3) getEmployeeFullData() no longer lets a failure reading an
 *     employee's OWN task sheet block their personal sheets from
 *     loading; response is round-tripped through sanitizeForClient_().
 *  4) Gmail/MailApp sending requires one-time authorization — see setup
 *     step G below.
 *  5) isAdminRole_() treats both "Admin" and "Manager" as elevated
 *     roles with full permissions everywhere in this file.
 *
 *  ===================== PERMISSIONS =====================
 *  Employees are VIEW-ONLY: they can see their own tasks, but cannot
 *  add, edit, or delete tasks. Admin AND Manager accounts can add/update/
 *  delete, and can see every employee's combined tasks, sheets, AND
 *  notifications (task-assigned + due-soon) across the whole team.
 *
 *  ===================== SETUP =====================
 *  A) Create ONE central Google Sheet with tabs: "Users", "SheetLinks",
 *     and "Notifications" (separate from each employee's own task
 *     spreadsheet). "Notifications" is auto-created on first use.
 *
 *  "Users" tab columns (Row 1 = headers):
 *     A: Username | B: Password | C: FullName | D: Role | E: PersonKey | F: Email
 *
 *  "SheetLinks" tab columns (Row 1 = headers) — OPTIONAL:
 *     A: Username | B: SheetLabel | C: SheetURL | D: TabName(optional)
 *
 *  B) Update SHEET_ID below with this central sheet's ID
 *  C) SHEETS_CONFIG below already has each employee's task spreadsheet
 *  D) Extensions > Apps Script, paste this as Code.gs; paste Index.html
 *     (name it exactly "Index" in Apps Script) as the other file
 *  E) Deploy > New deployment > Web app
 *       - Execute as: Me
 *       - Who has access: Anyone (or "Anyone within org")
 *  F) The Admin's Google account must have Editor access to every
 *     spreadsheet in SHEETS_CONFIG and Viewer access to every sheet
 *     listed in SheetLinks.
 *  G) One-time step to enable daily reminder emails AND authorize
 *     Gmail sending in general: run "createDailyReminderTrigger" once
 *     from the Apps Script editor, approve the Gmail-send prompt.
 *  H) IMPORTANT — after editing this file, you must create a NEW
 *     deployment VERSION for changes to take effect on the live web app
 *     (Deploy > Manage deployments > pencil icon > New version > Deploy).
 *  I) Browser popups additionally require the PERSON to click "Allow"
 *     on the notification-permission prompt their browser shows right
 *     after login. If they clicked "Block" earlier, they'll need to
 *     re-enable it from their browser's site settings — there is no
 *     way for this app to re-prompt them itself once blocked.
 **********************************************************************/

const SHEET_ID = '1tyZjvEhNS_1Hx6KXURWF_MLqLYPzKU6BSsXUigrgHmg'; // <-- the sheet with Users + SheetLinks tabs
const USERS_SHEET = 'Users';
const SHEETLINKS_SHEET = 'SheetLinks';
const NOTIFICATIONS_SHEET = 'Notifications';
const DONE_KEYWORDS = ['done', 'complete', 'completed', 'closed', 'yes'];

// Synthetic "PersonKey" used only for notifications meant for every
// Admin/Manager account (task-assigned broadcasts, due-soon alerts
// across all employees). Never a real employee — SHEETS_CONFIG can
// never have a key equal to this, so it cannot collide with a real
// employee's notifications.
const ADMIN_BROADCAST_KEY = '__ADMIN__';

// Roles that get full "Admin-equivalent" permissions: see combined
// tasks across every employee, see every employee's personal sheets,
// see every employee's notifications, and add/update/delete tasks.
// Add more role strings here if you ever introduce another elevated
// role — this is the ONLY place you need to change to alter that
// behavior everywhere in the file.
const ADMIN_ROLES_ = ['admin', 'manager'];
function isAdminRole_(role) {
  return ADMIN_ROLES_.indexOf((role || '').toString().trim().toLowerCase()) !== -1;
}

// Shared keyword groups used by both header-row detection and column
// detection, expanded to cover common real-world sheet header wording
// (e.g. "Planned" as a due date, "Doer Name" as the assignee column).
const COLUMN_KEYWORDS_ = {
  date:      { keywords: ['due', 'deadline', 'planned', 'target', 'date'], exclude: ['actual', 'done date', 'completed on', '%'] },
  status:    { keywords: ['status', 'done', 'complete'], exclude: [] },
  task:      { keywords: ['task', 'item', 'work'], exclude: ['id'] },
  assigned:  { keywords: ['doer', 'assigned', 'owner', 'responsible', 'accountable', 'name'], exclude: [] },
  desc:      { keywords: ['description', 'detail', 'note', 'remark'], exclude: [] },
  priority:  { keywords: ['priority'], exclude: [] }
};

// ============================================================
// TASK-SYSTEM CONFIGURATION: one entry per employee's own task sheet
// ============================================================
const SHEETS_CONFIG = {
  'person1': { id: '1Ixj3oj2N6gaB4FOzrG6-qnecABvI0Jj5VjX9-lSymTs', name: 'Brijpal_ji', sheetName: 'Brijpal_ji' },
  'person2': { id: '1kkzH6IoEyDUGF7hQ72RvjXZqGeb9ImDYTHFXVwp5LxY', name: 'Mukesh',     sheetName: 'Sheet1' },
  'person3': { id: '1jQ74rcSOFgSDAf0OXZuU-rq9no4g0TYSPvWYyBU4I4E', name: 'Sayeed',     sheetName: 'Sheet1' },
  'person4': { id: '1ecaXRywqS_p2CAl8mEG4_2jrJe1GKU4HMYio4zPApGk', name: 'Prashant',   sheetName: 'Sheet1' },
  'person5': { id: '15LtOnX_mBtw5zJ9Y4VWzco6-_fUO9Q5NiVdgy3UaOJI', name: 'Piyush',     sheetName: 'Sheet1' },
  'person6': { id: '12PQgC_OyFp0qaLBOnUhEimocRpgfkK9fis7KFzVyVq4', name: 'Sonu',       sheetName: 'Ajay sir' },
  'person7': { id: '1yVr-Rmx47MPqrksnU9LEanoiUyG5sQx7AW0WkyiQZdw', name: 'Nitesh',     sheetName: 'Sheet1' }
};

const DATA_START_ROW = 4; // Row where actual task data begins in each person's sheet

// ============================================================
// WEB APP ENTRY POINT
// ============================================================
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Employee Task Management System')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// ============================================================
// NAME NORMALIZATION (shared everywhere a "Username"/"Owner" string
// from a spreadsheet cell gets compared against another one)
// ============================================================
function normalizeName_(s) {
  return (s || '').toString().trim().toLowerCase().replace(/[_\s]+/g, ' ').trim();
}

// ============================================================
// CENTRAL SHEET HELPER (fuzzy tab-name matching)
// ============================================================
function getCentralSheet_(name) {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = ss.getSheetByName(name);
  if (sheet) return sheet;

  const target = name.toLowerCase().replace(/\s+/g, '');
  const all = ss.getSheets();
  for (let i = 0; i < all.length; i++) {
    if (all[i].getName().toLowerCase().replace(/\s+/g, '') === target) return all[i];
  }
  return null;
}

function getTabFuzzy_(ss, tabName) {
  let tab = ss.getSheetByName(tabName);
  if (tab) return tab;
  const target = tabName.toLowerCase().replace(/\s+/g, '');
  const all = ss.getSheets();
  for (let i = 0; i < all.length; i++) {
    if (all[i].getName().toLowerCase().replace(/\s+/g, '') === target) return all[i];
  }
  return null;
}

function pickDefaultTab_(ss) {
  const allSheets = ss.getSheets();
  if (allSheets.length <= 1) return allSheets[0];

  const exactPreferred = allSheets.find(s => s.getName().trim().toLowerCase() === 'fms');
  if (exactPreferred) return exactPreferred;

  const skipPatterns = [
    /^form\s*responses?/i,
    /^config$/i,
    /^holidays?$/i,
    /^instructions$/i,
    /^setup\s*sheet$/i,
    /^dashboard$/i
  ];
  const candidates = allSheets.filter(s => !skipPatterns.some(p => p.test(s.getName().trim())));
  const pool = candidates.length > 0 ? candidates : allSheets;

  let best = pool[0];
  let bestScore = -1;
  pool.forEach(s => {
    const score = s.getLastRow() * s.getLastColumn();
    if (score > bestScore) { bestScore = score; best = s; }
  });
  return best;
}

// ============================================================
// AUTH: real login against the "Users" tab, session tokens, permissions
// ============================================================

function loginUser(username, password) {
  username = (username || '').toString().trim();
  password = (password || '').toString().trim();

  if (!username || !password) {
    return { success: false, message: 'Please enter both username and password.' };
  }

  const sheet = getCentralSheet_(USERS_SHEET);
  if (!sheet) {
    return { success: false, message: 'Users tab not found. Check SHEET_ID and tab name.' };
  }

  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const sheetUser = (row[0] || '').toString().trim();
    const sheetPass = (row[1] || '').toString().trim();

    if (sheetUser.toLowerCase() === username.toLowerCase() && sheetPass === password) {
      const fullName = row[2] || sheetUser;
      const role = (row[3] || 'Employee').toString().trim();
      const personKey = (row[4] || '').toString().trim() || null;

      const token = Utilities.getUuid();
      const session = { username: sheetUser, fullName: fullName, role: role, personKey: personKey };
      CacheService.getScriptCache().put(token, JSON.stringify(session), 21600); // 6 hrs

      return { success: true, token: token, username: sheetUser, fullName: fullName, role: role, personKey: personKey };
    }
  }
  return { success: false, message: 'Invalid username or password. Please try again.' };
}

function verifySession_(token) {
  const cache = CacheService.getScriptCache();
  let raw = cache.get(token || '');

  for (let i = 0; i < 6 && !raw; i++) {
    Utilities.sleep(200);
    raw = cache.get(token || '');
  }

  if (!raw) throw new Error('Session expired. Please log in again.');
  return JSON.parse(raw);
}

function assertCanAccess_(session, personKey) {
  if (isAdminRole_(session.role)) return;
  if (session.personKey !== personKey) {
    throw new Error('You do not have permission to access this crew member\'s sheet.');
  }
}

function assertIsAdmin_(session) {
  if (!isAdminRole_(session.role)) {
    throw new Error('Only Admins/Managers can perform this action.');
  }
}

// ============================================================
// TASK ENGINE — reads/writes each employee's own task spreadsheet
// ============================================================

function rowToTask_(row, index, key, config) {
  return {
    rowNumber: index + DATA_START_ROW,
    TimestampRaw: row[0] ? new Date(row[0]).getTime() : 0,
    Timestamp:    row[0] ? formatDate(row[0]) : '',
    TaskName:     row[1] || '',
    AssignedTo:   row[2] || '',
    Description:  row[3] || '',
    Deadline:     row[4] ? formatDate(row[4]) : '',
    Priority:     row[5] || 'Medium',
    Status:       row[6] || 'Pending',
    DoneDate:     row[7] ? formatDate(row[7]) : '',
    WorkProgress: (row[8] !== '' && row[8] !== null && row[8] !== undefined) ? row[8] : 0,
    Remark:       row[9] || '',
    Owner:        config.name,
    OwnerKey:     key,
    SpreadsheetId: config.id,
    SheetName:    config.sheetName
  };
}

// ============================================================
// RETRY HELPER
// ============================================================
function withRetry_(fn, maxAttempts) {
  maxAttempts = maxAttempts || 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return fn();
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts) Utilities.sleep(300 * attempt); // 300ms, 600ms, ...
    }
  }
  throw lastErr;
}

function getAllTasks(token, forceRefresh) {
  const session = verifySession_(token);
  if (!isAdminRole_(session.role)) return getTasksByPerson(token, session.personKey);

  const cache = CacheService.getScriptCache();
  const cacheKey = 'allTasksCache_v1';

  if (!forceRefresh) {
    const cached = cache.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) { /* fall through and rebuild */ }
    }
  }

  const lock = LockService.getScriptLock();
  const gotLock = lock.tryLock(20000); // wait up to 20s for another rebuild in progress

  if (!gotLock) {
    const cachedWhileWaiting = cache.get(cacheKey);
    if (cachedWhileWaiting) {
      try { return JSON.parse(cachedWhileWaiting); } catch (e) { /* fall through */ }
    }
  } else if (!forceRefresh) {
    const cachedAfterLock = cache.get(cacheKey);
    if (cachedAfterLock) {
      try {
        const parsed = JSON.parse(cachedAfterLock);
        lock.releaseLock();
        return parsed;
      } catch (e) { /* fall through and rebuild */ }
    }
  }

  try {
    const allTasks = [];
    const errors = [];
    const validConfigs = Object.entries(SHEETS_CONFIG).filter(([key, config]) =>
      config.id && config.id.length >= 20 && !config.id.includes('PASTE'));

    const spreadsheets = {};
    for (const [key, config] of validConfigs) {
      try {
        spreadsheets[key] = withRetry_(() => SpreadsheetApp.openById(config.id), 3);
      } catch (e) {
        errors.push(config.name + ': cannot open - ' + e);
        Logger.log('Cannot open: ' + config.name + ' - ' + e);
      }
    }

    for (const [key, config] of validConfigs) {
      if (!spreadsheets[key]) continue;
      try {
        const sheet = spreadsheets[key].getSheetByName(config.sheetName);
        if (!sheet) { errors.push(config.name + ': tab not found'); continue; }

        const lastRow = sheet.getLastRow();
        const lastCol = sheet.getLastColumn();
        if (lastRow < DATA_START_ROW || lastCol === 0) continue;

        const numCols = Math.min(lastCol, 10);
        const totalDataRows = lastRow - DATA_START_ROW + 1;
        const data = withRetry_(() => sheet.getRange(DATA_START_ROW, 1, totalDataRows, numCols).getValues(), 3);

        const tasks = [];
        data.forEach((row, index) => {
          if (!row[1] && !row[2]) return;
          tasks.push(rowToTask_(row, index, key, config));
        });
        allTasks.push(...tasks);
      } catch (error) {
        errors.push(config.name + ': ' + error.message);
        Logger.log('Error: ' + config.name + ' - ' + error);
      }
    }

    allTasks.sort((a, b) => b.TimestampRaw - a.TimestampRaw);

    Logger.log('getAllTasks REAL RESULT: allTasks.length=' + allTasks.length + ', errors=' + JSON.stringify(errors));

    if (errors.length === 0) {
      try {
        cache.put(cacheKey, JSON.stringify(allTasks), 90);
      } catch (e) {
        Logger.log('getAllTasks cache write failed (result likely too large): ' + e);
      }
    } else {
      Logger.log('getAllTasks completed with errors, not caching: ' + errors.join(' | '));
    }

    return sanitizeForClient_(allTasks);
  } finally {
    if (gotLock) lock.releaseLock();
  }
}

function getTasksByPerson(token, personKey) {
  const session = verifySession_(token);
  assertCanAccess_(session, personKey);

  const config = SHEETS_CONFIG[personKey];
  if (!config) throw new Error('Person not found: ' + personKey);

  const ss = SpreadsheetApp.openById(config.id);
  const sheet = ss.getSheetByName(config.sheetName);
  if (!sheet) throw new Error('Sheet tab not found: ' + config.sheetName);

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < DATA_START_ROW || lastCol === 0) return [];

  const numCols = Math.min(lastCol, 10);
  const totalDataRows = lastRow - DATA_START_ROW + 1;
  const data = sheet.getRange(DATA_START_ROW, 1, totalDataRows, numCols).getValues();

  const tasks = [];
  data.forEach((row, index) => {
    if (!row[1] && !row[2]) return;
    tasks.push(rowToTask_(row, index, personKey, config));
  });
  tasks.sort((a, b) => b.TimestampRaw - a.TimestampRaw);
  return tasks;
}

// Employees are VIEW-ONLY — only Admin/Manager roles may add/update/delete tasks.
function addTaskToPerson(token, personKey, taskData) {
  const session = verifySession_(token);
  assertIsAdmin_(session);
  assertCanAccess_(session, personKey);

  const config = SHEETS_CONFIG[personKey];
  if (!config) throw new Error('Person not found: ' + personKey);

  const ss = SpreadsheetApp.openById(config.id);
  const sheet = ss.getSheetByName(config.sheetName);
  if (!sheet) throw new Error('Sheet not found');

  const now = new Date();
  sheet.appendRow([
    now, taskData.taskName || '', taskData.assignedTo || '', taskData.description || '',
    taskData.deadline || '', taskData.priority || 'Medium', 'Pending', '', 0, ''
  ]);
  const lastRow = sheet.getLastRow();
  sheet.getRange(lastRow, 1).setNumberFormat('dd/mm/yyyy hh:mm:ss');
  sheet.getRange(lastRow, 5).setNumberFormat('dd/mm/yyyy');

  // Email the employee that a task was just assigned to them.
  sendTaskAssignedEmail_(personKey, taskData);

  // In-portal notification scoped ONLY to this personKey, so just the
  // responsible employee sees it in their bell icon.
  createNotification_(personKey, 'New task assigned', buildTaskAssignedNotifText_(taskData));

  // NEW: broadcast the same event to every Admin/Manager account, so
  // they see (and get a browser popup for) every task assigned to
  // every employee, not just the ones they personally created.
  createNotification_(ADMIN_BROADCAST_KEY, 'Task assigned to ' + config.name,
    buildTaskAssignedNotifText_(taskData));

  CacheService.getScriptCache().remove('allTasksCache_v1');

  return { success: true, message: 'Task added to ' + config.name };
}

function updateTask(token, personKey, rowNumber, updateData) {
  const session = verifySession_(token);
  assertIsAdmin_(session);
  assertCanAccess_(session, personKey);

  const config = SHEETS_CONFIG[personKey];
  if (!config) throw new Error('Person not found: ' + personKey);

  const ss = SpreadsheetApp.openById(config.id);
  const sheet = ss.getSheetByName(config.sheetName);
  if (!sheet) throw new Error('Sheet not found');

  if (rowNumber < DATA_START_ROW || rowNumber > sheet.getLastRow()) throw new Error('Invalid row number: ' + rowNumber);

  if (updateData.status !== undefined) sheet.getRange(rowNumber, 7).setValue(updateData.status);
  if (updateData.status === 'Done') {
    sheet.getRange(rowNumber, 8).setValue(new Date());
    sheet.getRange(rowNumber, 8).setNumberFormat('dd/mm/yyyy');
  }
  if (updateData.workProgress !== undefined) sheet.getRange(rowNumber, 9).setValue(updateData.workProgress);
  if (updateData.remark !== undefined) sheet.getRange(rowNumber, 10).setValue(updateData.remark);
  if (updateData.priority !== undefined) sheet.getRange(rowNumber, 6).setValue(updateData.priority);
  CacheService.getScriptCache().remove('allTasksCache_v1');

  return { success: true, message: 'Task updated successfully' };
}

function deleteTask(token, personKey, rowNumber) {
  const session = verifySession_(token);
  assertIsAdmin_(session);
  assertCanAccess_(session, personKey);

  const config = SHEETS_CONFIG[personKey];
  if (!config) throw new Error('Person not found: ' + personKey);

  const ss = SpreadsheetApp.openById(config.id);
  const sheet = ss.getSheetByName(config.sheetName);
  if (!sheet) throw new Error('Sheet not found');

  if (rowNumber < DATA_START_ROW || rowNumber > sheet.getLastRow()) throw new Error('Invalid row number: ' + rowNumber);
  sheet.deleteRow(rowNumber);
  CacheService.getScriptCache().remove('allTasksCache_v1');
  return { success: true, message: 'Task deleted' };
}

function getPeopleList(token) {
  const session = verifySession_(token);
  if (isAdminRole_(session.role)) {
    return Object.keys(SHEETS_CONFIG).map(key => ({ key: key, name: SHEETS_CONFIG[key].name }));
  }
  const config = SHEETS_CONFIG[session.personKey];
  return config ? [{ key: session.personKey, name: config.name }] : [];
}

// ============================================================
// IN-PORTAL + BROWSER NOTIFICATIONS
// ============================================================
// Backed by a "Notifications" tab in the central sheet (auto-created on
// first use). Columns:
//   A: Id | B: Timestamp | C: PersonKey | D: Title | E: Message | F: Read
//
// PersonKey is either a real employee's key (their own tasks only) or
// ADMIN_BROADCAST_KEY (visible to every Admin/Manager account). This
// keeps one employee's notifications from ever leaking to another
// employee, while still giving Admin/Manager full visibility.

function getOrCreateNotificationsSheet_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = getCentralSheet_(NOTIFICATIONS_SHEET);
  if (sheet) return sheet;

  sheet = ss.insertSheet(NOTIFICATIONS_SHEET);
  sheet.appendRow(['Id', 'Timestamp', 'PersonKey', 'Title', 'Message', 'Read']);
  sheet.getRange(1, 1, 1, 6).setFontWeight('bold');
  return sheet;
}

/**
 * Creates a single in-portal notification, scoped to either one
 * employee's personKey or ADMIN_BROADCAST_KEY. Never throws out to the
 * caller — a notification write failure should never block the
 * task-add flow itself, since the task row is already saved by the
 * time this runs.
 */
function createNotification_(personKey, title, message) {
  try {
    if (!personKey) return; // nothing to notify — no employee tied to this task
    const sheet = getOrCreateNotificationsSheet_();
    const id = Date.now() + '_' + Math.floor(Math.random() * 1000); // avoid same-ms id collisions when 2 rows are written back-to-back
    sheet.appendRow([id, new Date(), personKey, title || '', message || '', false]);
  } catch (e) {
    Logger.log('createNotification_ error: ' + e);
  }
}

function buildTaskAssignedNotifText_(taskData) {
  const parts = [];
  if (taskData.deadline) parts.push('due ' + taskData.deadline);
  if (taskData.priority) parts.push(taskData.priority + ' priority');
  const meta = parts.length ? ' (' + parts.join(', ') + ')' : '';
  return '"' + (taskData.taskName || '(untitled)') + '"' + meta;
}

/**
 * Returns notifications for the LOGGED-IN user's scope:
 *   - a regular employee: their own personKey only
 *   - Admin/Manager: the shared ADMIN_BROADCAST_KEY feed, which covers
 *     every task-assigned event and every due-soon alert across ALL
 *     employees
 * Returns the most recent 40, newest first.
 */
function getMyNotifications(token) {
  const session = verifySession_(token);
  try {
    const scopeKey = isAdminRole_(session.role) ? ADMIN_BROADCAST_KEY : session.personKey;
    if (!scopeKey) return { notifications: [] };

    const sheet = getCentralSheet_(NOTIFICATIONS_SHEET);
    if (!sheet) return { notifications: [] };

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return { notifications: [] };

    const data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
    const mine = [];
    data.forEach((row, idx) => {
      const rowPersonKey = (row[2] || '').toString().trim();
      if (rowPersonKey !== scopeKey) return; // strictly scoped to this employee OR the admin broadcast feed
      mine.push({
        id: row[0],
        rowNumber: idx + 2,
        timestamp: formatDate(row[1]),
        title: row[3] || '',
        message: row[4] || '',
        read: row[5] === true || row[5] === 'TRUE' || row[5] === 'true'
      });
    });

    // Ids can be numeric (old rows) or "timestamp_rand" strings (new
    // rows) — sort by the numeric row insertion order via rowNumber
    // instead of trying to numerically compare ids of mixed shape.
    mine.sort((a, b) => b.rowNumber - a.rowNumber);
    return sanitizeForClient_({ notifications: mine.slice(0, 40) });
  } catch (e) {
    Logger.log('getMyNotifications error: ' + e);
    return { notifications: [] };
  }
}

/**
 * Marks the given notification ids as read, scoped to the caller's own
 * feed (their personKey, or the shared admin broadcast feed for
 * Admin/Manager). An id that doesn't belong to that scope is silently
 * skipped rather than trusted at face value.
 */
function markNotificationsRead(token, ids) {
  const session = verifySession_(token);
  const scopeKey = isAdminRole_(session.role) ? ADMIN_BROADCAST_KEY : session.personKey;
  if (!scopeKey || !ids || !ids.length) return { success: true };

  const sheet = getCentralSheet_(NOTIFICATIONS_SHEET);
  if (!sheet) return { success: true };

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { success: true };

  const idSet = new Set(ids.map(String));
  const data = sheet.getRange(2, 1, lastRow - 1, 6).getValues();
  data.forEach((row, idx) => {
    const rowPersonKey = (row[2] || '').toString().trim();
    if (rowPersonKey !== scopeKey) return; // ownership check
    if (idSet.has(String(row[0]))) {
      sheet.getRange(idx + 2, 6).setValue(true);
    }
  });

  return { success: true };
}

// ============================================================
// TEAM CHAT
// ============================================================
const CHAT_SHEET = 'Chat';

function getOrCreateChatSheet_() {
  const ss = SpreadsheetApp.openById(SHEET_ID);
  let sheet = getCentralSheet_(CHAT_SHEET);
  if (sheet) return sheet;

  sheet = ss.insertSheet(CHAT_SHEET);
  sheet.appendRow(['Timestamp', 'Username', 'FullName', 'Message']);
  sheet.getRange(1, 1, 1, 4).setFontWeight('bold');
  return sheet;
}

function getChatMessages(token, sinceRow) {
  const session = verifySession_(token);
  try {
    const sheet = getOrCreateChatSheet_();
    const lastRow = sheet.getLastRow();
    sinceRow = Number(sinceRow) || 1; // row 1 is the header row

    if (lastRow <= sinceRow) {
      return sanitizeForClient_({ messages: [], lastRow: lastRow });
    }

    const startRow = sinceRow + 1;
    const numRows = lastRow - sinceRow;
    const data = sheet.getRange(startRow, 1, numRows, 4).getValues();

    const messages = data.map((row, idx) => ({
      row: startRow + idx,
      timestamp: formatDate(row[0]),
      username: row[1] || '',
      fullName: row[2] || '',
      message: row[3] || ''
    }));

    return sanitizeForClient_({ messages: messages, lastRow: lastRow });
  } catch (e) {
    Logger.log('getChatMessages error: ' + e);
    return { messages: [], lastRow: Number(sinceRow) || 1 };
  }
}

function sendChatMessage(token, message) {
  const session = verifySession_(token);
  message = (message || '').toString().trim();
  if (!message) throw new Error('Message cannot be empty.');
  if (message.length > 2000) message = message.substring(0, 2000);

  const sheet = getOrCreateChatSheet_();
  sheet.appendRow([new Date(), session.username, session.fullName, message]);
  return { success: true };
}

// ============================================================
// EMAIL NOTIFICATIONS
// ============================================================

function getEmployeeEmail_(personKey) {
  const usersSheet = getCentralSheet_(USERS_SHEET);
  if (!usersSheet) return null;
  const data = usersSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if ((data[i][4] || '').toString().trim() === personKey) {
      const email = (data[i][5] || '').toString().trim();
      return email || null;
    }
  }
  return null;
}

function sendTaskAssignedEmail_(personKey, taskData) {
  try {
    const config = SHEETS_CONFIG[personKey];
    const email = getEmployeeEmail_(personKey);
    if (!email) { Logger.log('No email on file for ' + (config ? config.name : personKey) + ' — skipping notification.'); return; }

    const subject = 'New Task Assigned: ' + (taskData.taskName || '(untitled)');
    const body =
      'Hi ' + (config ? config.name : '') + ',\n\n' +
      'A new task has been assigned to you:\n\n' +
      'Task: ' + (taskData.taskName || '') + '\n' +
      'Assigned To: ' + (taskData.assignedTo || '') + '\n' +
      'Description: ' + (taskData.description || '') + '\n' +
      'Deadline: ' + (taskData.deadline || '') + '\n' +
      'Priority: ' + (taskData.priority || 'Medium') + '\n\n' +
      'Please log in to the Task Portal to view details.\n\n' +
      '— Employee Task Management System';

    MailApp.sendEmail(email, subject, body);
  } catch (e) {
    Logger.log('sendTaskAssignedEmail_ error: ' + e);
  }
}

function getTasksByPersonRaw_(personKey) {
  const config = SHEETS_CONFIG[personKey];
  if (!config) return [];
  const ss = SpreadsheetApp.openById(config.id);
  const sheet = ss.getSheetByName(config.sheetName);
  if (!sheet) return [];
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < DATA_START_ROW || lastCol === 0) return [];
  const numCols = Math.min(lastCol, 10);
  const totalDataRows = lastRow - DATA_START_ROW + 1;
  const data = sheet.getRange(DATA_START_ROW, 1, totalDataRows, numCols).getValues();
  const tasks = [];
  data.forEach((row, index) => {
    if (!row[1] && !row[2]) return;
    tasks.push(rowToTask_(row, index, personKey, config));
  });
  return tasks;
}

// ============================================================
// DAILY REMINDER JOB (email, once/day via trigger)
// ============================================================
function sendDailyTaskReminders() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);

  Object.keys(SHEETS_CONFIG).forEach(function (personKey) {
    try {
      const config = SHEETS_CONFIG[personKey];
      const email = getEmployeeEmail_(personKey);
      if (!email) return;

      const tasks = getTasksByPersonRaw_(personKey);
      const dueToday = [];
      const dueTomorrow = [];

      tasks.forEach(function (t) {
        if (t.Status === 'Done' || !t.Deadline) return;
        const parts = String(t.Deadline).split('/'); // formatDate() output: dd/mm/yyyy hh:mm
        if (parts.length < 3) return;
        const d = new Date(parts[2].split(' ')[0], parts[1] - 1, parts[0]);
        d.setHours(0, 0, 0, 0);
        if (d.getTime() === today.getTime()) dueToday.push(t);
        else if (d.getTime() === tomorrow.getTime()) dueTomorrow.push(t);
      });

      if (dueToday.length === 0 && dueTomorrow.length === 0) return;

      let body = 'Hi ' + config.name + ',\n\nHere is your task reminder:\n\n';
      if (dueToday.length) {
        body += 'DUE TODAY:\n';
        dueToday.forEach(t => body += '- ' + t.TaskName + ' (Priority: ' + t.Priority + ')\n');
        body += '\n';
      }
      if (dueTomorrow.length) {
        body += 'DUE TOMORROW:\n';
        dueTomorrow.forEach(t => body += '- ' + t.TaskName + ' (Priority: ' + t.Priority + ')\n');
        body += '\n';
      }
      body += 'Please log in to the Task Portal to update your progress.\n\n— Employee Task Management System';

      MailApp.sendEmail(email, 'Task Reminder: ' + (dueToday.length + dueTomorrow.length) + ' task(s) due', body);
    } catch (e) {
      Logger.log('sendDailyTaskReminders error for ' + personKey + ': ' + e);
    }
  });
}

function createDailyReminderTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendDailyTaskReminders') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendDailyTaskReminders')
    .timeBased()
    .everyDays(1)
    .atHour(8) // change this to run at a different hour, e.g. atHour(9)
    .create();
}

// ============================================================
// ADMIN/MANAGER: get full data for ONE employee (task sheet + personal sheets)
// ============================================================
function getEmployeeFullData(token, personKey) {
  const session = verifySession_(token);
  const config = SHEETS_CONFIG[personKey];
  if (!config) throw new Error('Person not found: ' + personKey);

  let tasks = [];
  let tasksError = null;
  try {
    tasks = getTasksByPerson(token, personKey);
  } catch (e) {
    tasksError = e.message || e.toString();
    Logger.log('getEmployeeFullData: could not load tasks for ' + personKey + ': ' + tasksError);
  }

  const usersSheet = getCentralSheet_(USERS_SHEET);
  let username = null, fullName = config.name;
  if (usersSheet) {
    const data = usersSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if ((data[i][4] || '').toString().trim() === personKey) {
        username = (data[i][0] || '').toString().trim();
        fullName = data[i][2] || fullName;
        break;
      }
    }
  }

  let personalSheets = [];
  let pendingWork = [];
  if (username) {
    const normUsername = normalizeName_(username);
    const normFullName = normalizeName_(fullName);
    const linksSheet = getCentralSheet_(SHEETLINKS_SHEET);
    if (linksSheet) {
      const data = linksSheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        const row = data[i];
        const owner = (row[0] || '').toString().trim();
        if (!owner) continue;
        const normOwner = normalizeName_(owner);
        if (normOwner === normUsername || (normFullName && normOwner === normFullName)) {
          const link = { owner: owner, label: row[1] || 'Untitled Sheet', url: row[2] || '', tabName: row[3] || '' };
          personalSheets.push(link);
          pendingWork = pendingWork.concat(scanSheetForPendingToday_(link, username, fullName));
        }
      }
    }
  }
  pendingWork.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));

  return sanitizeForClient_({
    personKey: personKey,
    name: config.name,
    username: username,
    tasks: tasks,
    personalSheets: personalSheets,
    pendingWork: pendingWork,
    tasksError: tasksError
  });
}

// ============================================================
// PERSONAL SHEETS (Checklist / FMS / Sales Report etc, via SheetLinks tab)
// ============================================================

function getUserSheets(token, forUsername) {
  const session = verifySession_(token);
  try {
    const sheet = getCentralSheet_(SHEETLINKS_SHEET);
    if (!sheet) return [];

    const data = sheet.getDataRange().getValues();
    if (data.length < 2) return [];
    const links = [];

    const scopeUsername = normalizeName_(forUsername || '');
    const sessionUsernameNorm = normalizeName_(session.username);

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const owner = (row[0] || '').toString().trim();
      if (!owner) continue;
      const normOwner = normalizeName_(owner);

      if (scopeUsername) {
        if (normOwner !== scopeUsername) continue;
      } else if (!isAdminRole_(session.role) && normOwner !== sessionUsernameNorm) {
        continue;
      }

      links.push({ owner: owner, label: row[1] || 'Untitled Sheet', url: row[2] || '', tabName: row[3] || '' });
    }
    return links;
  } catch (e) {
    Logger.log('getUserSheets error: ' + e);
    return [];
  }
}

function extractSheetId_(url) {
  const match = (url || '').match(/\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

function findColumn_(headers, keywords, exclude) {
  exclude = exclude || [];
  const norm = (h) => (h || '').toString().trim().toLowerCase();

  for (const k of keywords) {
    for (let i = 0; i < headers.length; i++) {
      if (norm(headers[i]) === k) return i;
    }
  }

  for (const k of keywords) {
    for (let i = 0; i < headers.length; i++) {
      const h = norm(headers[i]);
      if (exclude.some(x => h.includes(x))) continue;
      if (h.includes(k)) return i;
    }
  }

  return -1;
}

function findHeaderRow_(data, maxRowsToScan) {
  const limit = Math.min(maxRowsToScan || 15, data.length);
  let bestIndex = 0;
  let bestScore = 0;

  for (let r = 0; r < limit; r++) {
    const row = data[r];
    if (!row) continue;

    let score = 0;
    Object.values(COLUMN_KEYWORDS_).forEach(group => {
      if (findColumn_(row, group.keywords, group.exclude) !== -1) score++;
    });

    const hasDateLike = findColumn_(row, COLUMN_KEYWORDS_.date.keywords, COLUMN_KEYWORDS_.date.exclude) !== -1;
    if (hasDateLike && score > bestScore) {
      bestScore = score;
      bestIndex = r;
    }
  }

  return { headerRowIndex: bestIndex, headers: data[bestIndex] || data[0] };
}

function findAllColumns_(headers, exactText) {
  const target = (exactText || '').toString().trim().toLowerCase();
  const found = [];
  for (let i = 0; i < headers.length; i++) {
    const h = (headers[i] || '').toString().trim().toLowerCase();
    if (h === target) found.push(i);
  }
  return found;
}

function findColumnInRange_(headers, start, end, keywords) {
  for (let i = start; i <= end; i++) {
    const h = (headers[i] || '').toString().trim().toLowerCase();
    if (keywords.some(k => h === k)) return i;
  }
  for (let i = start; i <= end; i++) {
    const h = (headers[i] || '').toString().trim().toLowerCase();
    if (keywords.some(k => h.includes(k))) return i;
  }
  return -1;
}

function scanMultiStagePendingToday_(link, username, fullName, data, headers, headerRowIndex, firstDataRow) {
  const statusCols = findAllColumns_(headers, 'status');
  if (statusCols.length < 2) return null; // not a pipeline sheet

  const stages = statusCols.map(function (sc, idx) {
    const blockStart = idx === 0 ? 0 : statusCols[idx - 1] + 1;
    const labelEnd = idx === statusCols.length - 1 ? headers.length - 1 : statusCols[idx + 1] - 1;
    return {
      blockStart: blockStart,
      labelEnd: labelEnd,
      statusCol: sc,
      plannedCol: findColumnInRange_(headers, blockStart, sc, ['planned']),
      actualCol: findColumnInRange_(headers, blockStart, sc, ['actual'])
    };
  });

  const labelScanStart = Math.max(0, headerRowIndex - 8);
  stages.forEach(function (stage, idx) {
    let bestLabel = '';
    for (let r = labelScanStart; r < headerRowIndex; r++) {
      const row = data[r];
      if (!row) continue;
      for (let c = stage.blockStart; c <= stage.labelEnd; c++) {
        const val = (row[c] || '').toString().trim();
        if (val && val.length > bestLabel.length) bestLabel = val;
      }
    }
    stage.label = bestLabel || ('Step ' + (idx + 1));
  });

  const firstAnchor = stages[0].plannedCol !== -1 ? stages[0].plannedCol : stages[0].statusCol;
  const preambleEnd = Math.max(0, firstAnchor - 1);

  let identityCol = findColumnInRange_(headers, 0, preambleEnd, ['vessel', 'supplier', 'party', 'client', 'name']);
  if (identityCol === -1) identityCol = Math.min(1, headers.length - 1);

  const fallbackDateCol = findColumnInRange_(headers, 0, preambleEnd, ['timestamp', 'date']);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const results = [];

  for (let i = firstDataRow; i < data.length; i++) {
    const row = data[i];
    const identity = (row[identityCol] || '').toString().trim();
    if (!identity) continue;

    for (let s = 0; s < stages.length; s++) {
      const stage = stages[s];
      const rawStatus = (row[stage.statusCol] || '').toString().trim().toLowerCase();
      const isExplicitlyNotDone = /\bnot\b/.test(rawStatus) ||
                                   rawStatus === 'pending' ||
                                   rawStatus === 'no' ||
                                   rawStatus.includes('incomplete');
      const isDone = !isExplicitlyNotDone && DONE_KEYWORDS.some(k => rawStatus.includes(k));
      if (isDone) continue;

      let refDate = null;
      const rawRef = (stage.plannedCol !== -1 ? row[stage.plannedCol] : null) ||
                     (fallbackDateCol !== -1 ? row[fallbackDateCol] : null);
      if (rawRef) {
        const d = rawRef instanceof Date ? rawRef : new Date(rawRef);
        if (!isNaN(d.getTime()) && d.getFullYear() >= 2000) { d.setHours(0, 0, 0, 0); refDate = d; }
      }

      if (refDate && refDate.getTime() > today.getTime()) break;

      results.push({
        sheetLabel: link.label,
        owner: link.owner,
        task: identity,
        description: 'Stuck at: ' + stage.label,
        priority: '',
        status: row[stage.statusCol] || 'Pending',
        dueDate: refDate ? Utilities.formatDate(refDate, Session.getScriptTimeZone(), 'MMM dd, yyyy') : '—',
        isOverdue: !!(refDate && refDate.getTime() < today.getTime()),
        sheetUrl: link.url
      });
      break;
    }
  }

  return results;
}

function scanSheetForPendingToday_(link, username, fullName) {
  const results = [];
  const sheetId = extractSheetId_(link.url);
  if (!sheetId) return results;

  try {
    const ss = SpreadsheetApp.openById(sheetId);
    const tab = link.tabName ? getTabFuzzy_(ss, link.tabName) : pickDefaultTab_(ss);
    if (!tab) return results;

    const data = tab.getDataRange().getValues();
    if (data.length < 2) return results;

    const headerInfo = findHeaderRow_(data, 15);
    const headers = headerInfo.headers;
    const firstDataRow = headerInfo.headerRowIndex + 1;

    const multiStageResults = scanMultiStagePendingToday_(
      link, username, fullName, data, headers, headerInfo.headerRowIndex, firstDataRow
    );
    if (multiStageResults !== null) return multiStageResults;

    const dateCol = findColumn_(headers, COLUMN_KEYWORDS_.date.keywords, COLUMN_KEYWORDS_.date.exclude);
    const statusCol = findColumn_(headers, COLUMN_KEYWORDS_.status.keywords, COLUMN_KEYWORDS_.status.exclude);
    const taskCol = findColumn_(headers, COLUMN_KEYWORDS_.task.keywords, COLUMN_KEYWORDS_.task.exclude);
    const assignedCol = findColumn_(headers, COLUMN_KEYWORDS_.assigned.keywords, COLUMN_KEYWORDS_.assigned.exclude);
    const descCol = findColumn_(headers, COLUMN_KEYWORDS_.desc.keywords, COLUMN_KEYWORDS_.desc.exclude);
    const priorityCol = findColumn_(headers, COLUMN_KEYWORDS_.priority.keywords, COLUMN_KEYWORDS_.priority.exclude);

    if (dateCol === -1) return results;
    if (taskCol === -1 && assignedCol === -1) return results;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const normUsername = normalizeName_(username);
    const normFullName = normalizeName_(fullName);

    for (let i = firstDataRow; i < data.length; i++) {
      const row = data[i];
      const rawDate = row[dateCol];
      if (!rawDate) continue;
      const rowDate = rawDate instanceof Date ? rawDate : new Date(rawDate);
      if (isNaN(rowDate.getTime())) continue;
      rowDate.setHours(0, 0, 0, 0);
      if (rowDate.getFullYear() < 2000) continue;
      if (rowDate.getTime() > today.getTime()) continue;

      if (statusCol !== -1) {
        const rawStatus = (row[statusCol] || '').toString().trim().toLowerCase();
        const isExplicitlyNotDone = /\bnot\b/.test(rawStatus) ||
                                     rawStatus === 'pending' ||
                                     rawStatus === 'no' ||
                                     rawStatus.includes('incomplete');
        const isDone = !isExplicitlyNotDone && DONE_KEYWORDS.some(k => rawStatus.includes(k));
        if (isDone) continue;
      }

      if (assignedCol !== -1) {
        const assignedVal = normalizeName_(row[assignedCol]);
        const matchesUser = assignedVal === normUsername ||
                             assignedVal === normFullName ||
                             (normUsername && assignedVal.includes(normUsername)) ||
                             (normFullName && assignedVal.includes(normFullName));
        if (!matchesUser) continue;
      }

      results.push({
        sheetLabel: link.label,
        owner: link.owner,
        task: taskCol !== -1 ? (row[taskCol] || 'Untitled item') : 'Untitled item',
        description: descCol !== -1 ? (row[descCol] || '') : '',
        priority: priorityCol !== -1 ? (row[priorityCol] || '') : '',
        status: statusCol !== -1 ? (row[statusCol] || 'Pending') : 'Pending',
        dueDate: Utilities.formatDate(rowDate, Session.getScriptTimeZone(), 'MMM dd, yyyy'),
        isOverdue: rowDate.getTime() < today.getTime(),
        sheetUrl: link.url
      });
    }
  } catch (e) {
    Logger.log('scanSheetForPendingToday_ error for ' + link.label + ': ' + e);
  }
  return results;
}

function getTodayPendingWork(token) {
  const session = verifySession_(token);
  try {
    const links = getUserSheets(token);
    let allPending = [];
    links.forEach(link => {
      try {
        allPending = allPending.concat(scanSheetForPendingToday_(link, session.username, session.fullName));
      } catch (e) {
        Logger.log('getTodayPendingWork: error scanning ' + link.label + ': ' + e);
      }
    });
    allPending.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
    return sanitizeForClient_(allPending);
  } catch (e) {
    Logger.log('getTodayPendingWork error: ' + e);
    return [];
  }
}

// ============================================================
// DEBUG (Admin/Manager only)
// ============================================================
function debugSheets(token) {
  const session = verifySession_(token);
  if (!isAdminRole_(session.role)) throw new Error('Admin/Manager only.');

  for (const [key, config] of Object.entries(SHEETS_CONFIG)) {
    try {
      const ss = SpreadsheetApp.openById(config.id);
      const sheet = ss.getSheetByName(config.sheetName);
      if (!sheet) {
        Logger.log(config.name + ': TAB NOT FOUND - available: ' + ss.getSheets().map(s => s.getName()).join(', '));
        continue;
      }
      Logger.log(config.name + ': lastRow=' + sheet.getLastRow());
    } catch (e) {
      Logger.log(config.name + ': ERROR - ' + e);
    }
  }
}

function debugAllTasksReport(token) {
  const session = verifySession_(token);
  assertIsAdmin_(session);

  const report = [];

  Object.entries(SHEETS_CONFIG).forEach(function ([key, config]) {
    const entry = {
      personKey: key,
      name: config.name,
      configuredSpreadsheetId: config.id,
      configuredTabName: config.sheetName,
      dataStartRowConfigured: DATA_START_ROW
    };

    if (!config.id || config.id.length < 20 || config.id.includes('PASTE')) {
      entry.error = 'Spreadsheet ID looks invalid, blank, or is still a placeholder — update SHEETS_CONFIG. This is why this person is silently excluded from the combined view.';
      report.push(entry);
      return;
    }

    let ss;
    try {
      ss = SpreadsheetApp.openById(config.id);
      entry.spreadsheetOpened = true;
    } catch (e) {
      entry.spreadsheetOpened = false;
      entry.error = 'Could not open this spreadsheet: ' + e.toString() +
        ' — most likely cause: the Google account that deployed this web app ' +
        '("Execute as: Me") does not have Editor access to this spreadsheet ID. ' +
        'Share the sheet with that account and try again.';
      report.push(entry);
      return;
    }

    entry.allTabsInSpreadsheet = ss.getSheets().map(s => s.getName());

    const sheet = ss.getSheetByName(config.sheetName);
    if (!sheet) {
      entry.error = 'Tab "' + config.sheetName + '" was not found in this spreadsheet. ' +
        'Available tabs are listed in allTabsInSpreadsheet above — update SHEETS_CONFIG.sheetName to match exactly.';
      report.push(entry);
      return;
    }

    entry.tabFound = true;
    entry.lastRow = sheet.getLastRow();
    entry.lastColumn = sheet.getLastColumn();

    if (entry.lastRow < DATA_START_ROW) {
      entry.warning = 'lastRow (' + entry.lastRow + ') is below DATA_START_ROW (' + DATA_START_ROW +
        ') — this sheet will contribute ZERO tasks. Either add data starting at row ' + DATA_START_ROW +
        ', or change DATA_START_ROW at the top of Code.gs if your real data starts on a different row.';
      report.push(entry);
      return;
    }

    try {
      const numCols = Math.min(entry.lastColumn, 10);
      const sampleRowCount = Math.min(3, entry.lastRow - DATA_START_ROW + 1);
      const sample = sheet.getRange(DATA_START_ROW, 1, sampleRowCount, numCols).getValues();
      entry.sampleDataRows = sample;
      entry.sampleRowsThatWouldBeSkipped = sample.filter(r => !r[1] && !r[2]).length;
    } catch (e) {
      entry.error = 'Could not read sample rows: ' + e.toString();
    }

    report.push(entry);
  });

  return sanitizeForClient_(report);
}

function debugPendingScan(token, forPersonKey) {
  let session;
  try {
    session = verifySession_(token);
  } catch (e) {
    return [{ error: 'Session error: ' + e.toString() }];
  }

  try {
    let forUsername = null;
    if (forPersonKey && SHEETS_CONFIG[forPersonKey]) {
      const usersSheet = getCentralSheet_(USERS_SHEET);
      if (usersSheet) {
        const data = usersSheet.getDataRange().getValues();
        for (let i = 1; i < data.length; i++) {
          if ((data[i][4] || '').toString().trim() === forPersonKey) {
            forUsername = (data[i][0] || '').toString().trim();
            break;
          }
        }
      }
    }

    const links = getUserSheets(token, forUsername);
    const report = [];

    if (links.length === 0) {
      report.push({ info: 'No SheetLinks rows found for this scope. Check the SheetLinks tab has a row whose Username matches, and that forPersonKey/username resolved correctly.' });
    }

    links.forEach(function(link) {
      const entry = { label: link.label, tabNameRequested: link.tabName, url: link.url };
      const sheetId = extractSheetId_(link.url);
      if (!sheetId) { entry.error = 'Could not extract a Sheet ID from this URL.'; report.push(entry); return; }

      try {
        const ss = SpreadsheetApp.openById(sheetId);
        entry.allTabsInSpreadsheet = ss.getSheets().map(s => s.getName());
        const tab = link.tabName ? getTabFuzzy_(ss, link.tabName) : pickDefaultTab_(ss);
        if (!tab) { entry.error = 'Tab "' + link.tabName + '" not found.'; report.push(entry); return; }
        entry.tabActuallyUsed = tab.getName();

        const data = tab.getDataRange().getValues();
        entry.totalRows = data.length - 1;
        if (data.length < 2) { entry.error = 'No data rows.'; report.push(entry); return; }

        const headerInfo = findHeaderRow_(data, 15);
        const headers = headerInfo.headers;
        entry.headerRowDetected = headerInfo.headerRowIndex + 1;
        entry.headersFound = headers;

        const statusCols = findAllColumns_(headers, 'status');
        entry.isMultiStagePipeline = statusCols.length >= 2;
        if (entry.isMultiStagePipeline) {
          entry.stageStatusColumnsFound = statusCols.map(c => headers[c] + ' (col ' + (c + 1) + ')');
        }

        const dateCol = findColumn_(headers, COLUMN_KEYWORDS_.date.keywords, COLUMN_KEYWORDS_.date.exclude);
        const statusCol = findColumn_(headers, COLUMN_KEYWORDS_.status.keywords, COLUMN_KEYWORDS_.status.exclude);
        const taskCol = findColumn_(headers, COLUMN_KEYWORDS_.task.keywords, COLUMN_KEYWORDS_.task.exclude);
        const assignedCol = findColumn_(headers, COLUMN_KEYWORDS_.assigned.keywords, COLUMN_KEYWORDS_.assigned.exclude);

        entry.detectedColumns = {
          dateColumn: dateCol !== -1 ? headers[dateCol] : 'NOT FOUND',
          statusColumn: statusCol !== -1 ? headers[statusCol] : 'NOT FOUND',
          taskColumn: taskCol !== -1 ? headers[taskCol] : 'NOT FOUND',
          assignedToColumn: assignedCol !== -1 ? headers[assignedCol] : 'NOT FOUND'
        };

        const scanResult = scanSheetForPendingToday_(link, session.username, session.fullName);
        entry.pendingItemsFound = scanResult.length;
      } catch (e) {
        entry.error = 'Exception: ' + e.toString();
      }
      report.push(entry);
    });

    return sanitizeForClient_(report);
  } catch (e) {
    Logger.log('debugPendingScan top-level error: ' + e);
    return [{ error: 'debugPendingScan crashed before building the report: ' + e.toString() }];
  }
}

function debugNameLookup(token, nameToCheck) {
  const session = verifySession_(token);
  assertIsAdmin_(session);
  nameToCheck = (nameToCheck || '').toString().trim();
  if (!nameToCheck) throw new Error('Provide a name to check.');

  const report = { nameToCheck: nameToCheck, usersTabMatches: [], sheetLinksRows: [] };
  const normTarget = normalizeName_(nameToCheck);

  const usersSheet = getCentralSheet_(USERS_SHEET);
  if (usersSheet) {
    const usersData = usersSheet.getDataRange().getValues();
    usersData.forEach((row, i) => {
      if (i === 0) return;
      const username = (row[0] || '').toString();
      const fullName = (row[2] || '').toString();
      if (normalizeName_(username) === normTarget || normalizeName_(fullName) === normTarget || normalizeName_(username).includes(normTarget)) {
        report.usersTabMatches.push({
          row: i + 1, username: username, fullName: fullName,
          role: row[3], personKey: row[4],
          usernameCharCodes: Array.from(username).map(c => c.charCodeAt(0))
        });
      }
    });
  }

  const linksSheet = getCentralSheet_(SHEETLINKS_SHEET);
  if (linksSheet) {
    const linksData = linksSheet.getDataRange().getValues();
    linksData.forEach((row, i) => {
      if (i === 0) return;
      const owner = (row[0] || '').toString();
      const normOwner = normalizeName_(owner);
      report.sheetLinksRows.push({
        row: i + 1, owner: owner, label: row[1], url: row[2], tabName: row[3],
        normalizedOwner: normOwner,
        wouldMatchTarget: normOwner === normTarget,
        ownerCharCodes: Array.from(owner).map(c => c.charCodeAt(0))
      });
    });
  }

  return sanitizeForClient_(report);
}

function sanitizeForClient_(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (e) {
    Logger.log('sanitizeForClient_ failed: ' + e);
    return [{ error: 'Report was built but could not be serialized for the browser: ' + e.toString() }];
  }
}

// ============================================================
// HELPER: FORMAT DATE
// ============================================================
function formatDate(dateValue) {
  if (!dateValue) return '';
  try {
    let date;
    if (dateValue instanceof Date) date = dateValue;
    else if (typeof dateValue === 'string') date = new Date(dateValue);
    else if (typeof dateValue === 'number') date = new Date(Math.round((dateValue - 25569) * 86400 * 1000));
    else return dateValue;

    if (isNaN(date.getTime())) return dateValue;

    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return day + '/' + month + '/' + year + ' ' + hours + ':' + minutes;
  } catch (error) {
    return dateValue;
  }
}

function debugSayeedLookup() {
  const nameToCheck = 'Sayeed';

  const usersSheet = getCentralSheet_(USERS_SHEET);
  if (!usersSheet) { Logger.log('Users tab not found!'); return; }
  const usersData = usersSheet.getDataRange().getValues();
  Logger.log('--- USERS TAB ROWS CONTAINING "' + nameToCheck + '" ---');
  usersData.forEach((row, i) => {
    if (i === 0) return;
    const rowText = row.join(' | ').toLowerCase();
    if (rowText.includes(nameToCheck.toLowerCase())) {
      Logger.log('Row ' + (i+1) + ': Username="' + row[0] + '" FullName="' + row[2] + '" Role="' + row[3] + '" PersonKey="' + row[4] + '"');
    }
  });

  const linksSheet = getCentralSheet_(SHEETLINKS_SHEET);
  if (!linksSheet) { Logger.log('SheetLinks tab not found!'); return; }
  const linksData = linksSheet.getDataRange().getValues();
  Logger.log('--- ALL SheetLinks ROWS (so you can see EXACT spelling in column A) ---');
  linksData.forEach((row, i) => {
    if (i === 0) return;
    Logger.log('Row ' + (i+1) + ': Username="' + row[0] + '" Label="' + row[1] + '" URL="' + row[2] + '"');
  });

  Logger.log('--- Rows that WOULD match "' + nameToCheck + '" (case-insensitive exact) ---');
  const matches = linksData.filter((row, i) => i > 0 && (row[0]||'').toString().trim().toLowerCase() === nameToCheck.toLowerCase());
  Logger.log('Matched count: ' + matches.length);
}

// ============================================================
// LIVE DUE-TODAY / DUE-TOMORROW CHECK (in-portal, on page load / poll)
// ============================================================
// For a regular employee: scans their OWN tasks only (unchanged from
// before). For Admin/Manager: scans EVERY employee's tasks and writes
// a broadcast notification for each one due today/tomorrow, prefixed
// with the employee's name so it's clear whose task it is.
//
// Uses a script-cache dedupe key per (scope + personKey + task row +
// deadline) so the same task doesn't spam a fresh notification every
// poll — once notified, it stays quiet for 20 hours even on refresh.
function checkDueSoonAndNotify(token) {
  const session = verifySession_(token);
  const cache = CacheService.getScriptCache();

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);

  function scanAndNotify(personKey, notifyKey, namePrefix) {
    const tasks = getTasksByPersonRaw_(personKey);
    let notified = 0;

    tasks.forEach(function (t) {
      if (t.Status === 'Done' || !t.Deadline) return;
      const parts = String(t.Deadline).split('/'); // dd/mm/yyyy hh:mm
      if (parts.length < 3) return;
      const d = new Date(parts[2].split(' ')[0], parts[1] - 1, parts[0]);
      d.setHours(0, 0, 0, 0);

      let label = null;
      if (d.getTime() === today.getTime()) label = 'due today';
      else if (d.getTime() === tomorrow.getTime()) label = 'due tomorrow';
      if (!label) return;

      // Dedupe key includes notifyKey so the employee's own copy and the
      // admin-broadcast copy of the same task are tracked independently.
      const dedupeKey = 'dueSoon_' + notifyKey + '_' + personKey + '_' + t.rowNumber + '_' + t.Deadline;
      if (cache.get(dedupeKey)) return; // already notified within the last 20 hours

      const title = 'Task ' + label;
      const message = (namePrefix ? '[' + namePrefix + '] ' : '') +
        '"' + (t.TaskName || '(untitled)') + '"' + (t.Priority ? ' (' + t.Priority + ' priority)' : '');

      createNotification_(notifyKey, title, message);
      cache.put(dedupeKey, '1', 72000); // 20 hours
      notified++;
    });

    return { checked: tasks.length, notified: notified };
  }

  if (isAdminRole_(session.role)) {
    // Admin/Manager: scan EVERY employee's tasks, broadcast alerts to
    // the shared admin notification feed.
    let totalChecked = 0, totalNotified = 0;
    Object.keys(SHEETS_CONFIG).forEach(function (personKey) {
      const config = SHEETS_CONFIG[personKey];
      const result = scanAndNotify(personKey, ADMIN_BROADCAST_KEY, config ? config.name : personKey);
      totalChecked += result.checked;
      totalNotified += result.notified;
    });
    return { checked: totalChecked, notified: totalNotified };
  }

  if (!session.personKey) return { checked: 0, notified: 0 }; // shouldn't happen — non-admin with no personKey
  return scanAndNotify(session.personKey, session.personKey, null);
}
// WHATSAPP REMINDERS via Twilio — PRODUCTION (Content Template) VERSION
// ============================================================
// (unchanged from before — see inline comments in each function)
// ============================================================

const TWILIO_ACCOUNT_SID   = 'ACd6572a3adb04e332cb0cf1fcbf4111d3'; // your Account SID
const TWILIO_AUTH_TOKEN    = 'a83351338882854001f9feb6d05f7881';   // your Auth Token — regenerate once setup is confirmed working
const TWILIO_WHATSAPP_FROM = '+17372508034';              // Twilio sandbox number (change for production)

const TASK_ASSIGNED_CONTENT_SID  = 'HXfe5ab5f00277942d4d4200328b4d403c'; // <-- replace with your "task_assigned" template's Content SID
const DAILY_REMINDER_CONTENT_SID = 'HX_REPLACE_WITH_DAILY_REMINDER_TEMPLATE_SID'; // <-- create this template, then paste its SID here

function getEmployeeWhatsApp_(personKey) {
  const usersSheet = getCentralSheet_(USERS_SHEET);
  if (!usersSheet) return null;
  const data = usersSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if ((data[i][4] || '').toString().trim() === personKey) {
      const wa = (data[i][6] || '').toString().trim(); // column G = index 6
      return wa || null;
    }
  }
  return null;
}

function sendWhatsAppTemplate_(toNumber, contentSid, contentVariables) {
  if (!toNumber || !contentSid) return false;

  if (!/^\+\d{7,15}$/.test(toNumber.replace(/\s/g, ''))) {
    Logger.log('sendWhatsAppTemplate_: invalid number format for "' + toNumber + '" — skipping. Use E.164 e.g. +91XXXXXXXXXX');
    return false;
  }

  const url = 'https://api.twilio.com/2010-04-01/Accounts/' + TWILIO_ACCOUNT_SID + '/Messages.json';
  const credentials = Utilities.base64Encode(TWILIO_ACCOUNT_SID + ':' + TWILIO_AUTH_TOKEN);

  const payload = {
    From: TWILIO_WHATSAPP_FROM,
    To: 'whatsapp:' + toNumber.replace(/\s/g, ''),
    ContentSid: contentSid,
    ContentVariables: JSON.stringify(contentVariables || {})
  };

  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      headers: { Authorization: 'Basic ' + credentials },
      payload: payload,
      muteHttpExceptions: true
    });

    const code = response.getResponseCode();
    if (code >= 200 && code < 300) {
      Logger.log('sendWhatsAppTemplate_: sent to ' + toNumber + ' via ' + contentSid + ' (' + code + ')');
      return true;
    }

    const body = response.getContentText();
    Logger.log('sendWhatsAppTemplate_: Twilio returned ' + code + ' for ' + toNumber + ': ' + body);
    return false;
  } catch (e) {
    Logger.log('sendWhatsAppTemplate_: UrlFetchApp error for ' + toNumber + ': ' + e);
    return false;
  }
}

function sendWhatsApp_(toNumber, message) {
  if (!toNumber || !message) return false;

  if (!/^\+\d{7,15}$/.test(toNumber.replace(/\s/g, ''))) {
    Logger.log('sendWhatsApp_: invalid number format for "' + toNumber + '" — skipping. Use E.164 e.g. +91XXXXXXXXXX');
    return false;
  }

  const url = 'https://api.twilio.com/2010-04-01/Accounts/' + TWILIO_ACCOUNT_SID + '/Messages.json';
  const credentials = Utilities.base64Encode(TWILIO_ACCOUNT_SID + ':' + TWILIO_AUTH_TOKEN);

  const payload = {
    From: TWILIO_WHATSAPP_FROM,
    To: 'whatsapp:' + toNumber.replace(/\s/g, ''),
    Body: message
  };

  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      headers: { Authorization: 'Basic ' + credentials },
      payload: payload,
      muteHttpExceptions: true
    });

    const code = response.getResponseCode();
    if (code >= 200 && code < 300) {
      Logger.log('sendWhatsApp_: sent to ' + toNumber + ' (' + code + ')');
      return true;
    }

    const body = response.getContentText();
    Logger.log('sendWhatsApp_: Twilio returned ' + code + ' for ' + toNumber + ': ' + body);
    return false;
  } catch (e) {
    Logger.log('sendWhatsApp_: UrlFetchApp error for ' + toNumber + ': ' + e);
    return false;
  }
}

function sendTaskAssignedWhatsApp_(personKey, taskData) {
  try {
    const config = SHEETS_CONFIG[personKey];
    const waNumber = getEmployeeWhatsApp_(personKey);
    if (!waNumber) {
      Logger.log('sendTaskAssignedWhatsApp_: no WhatsApp number for ' + (config ? config.name : personKey) + ' — skipping.');
      return;
    }

    const personName = config ? config.name : (taskData.assignedTo || '');
    const variables = {
      '1': personName,
      '2': taskData.taskName || '(untitled)',
      '3': taskData.priority || 'Medium',
      '4': taskData.deadline || 'Not set'
    };

    sendWhatsAppTemplate_(waNumber, TASK_ASSIGNED_CONTENT_SID, variables);
  } catch (e) {
    Logger.log('sendTaskAssignedWhatsApp_ error: ' + e);
  }
}

function sendDailyWhatsAppReminders() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
  const MAX_LIST_CHARS = 300;

  Object.keys(SHEETS_CONFIG).forEach(function (personKey) {
    try {
      const config = SHEETS_CONFIG[personKey];
      const waNumber = getEmployeeWhatsApp_(personKey);
      if (!waNumber) return;

      const tasks = getTasksByPersonRaw_(personKey);
      const dueToday = [];
      const dueTomorrow = [];

      tasks.forEach(function (t) {
        if (t.Status === 'Done' || !t.Deadline) return;
        const parts = String(t.Deadline).split('/');
        if (parts.length < 3) return;
        const d = new Date(
          parseInt(parts[2].split(' ')[0]),
          parseInt(parts[1]) - 1,
          parseInt(parts[0])
        );
        d.setHours(0, 0, 0, 0);
        if (d.getTime() === today.getTime()) dueToday.push(t);
        else if (d.getTime() === tomorrow.getTime()) dueTomorrow.push(t);
      });

      if (dueToday.length === 0 && dueTomorrow.length === 0) return;

      const formatList = function (list) {
        if (list.length === 0) return 'None';
        let text = list.map(function (t) { return t.TaskName + ' (' + t.Priority + ')'; }).join(', ');
        if (text.length > MAX_LIST_CHARS) text = text.substring(0, MAX_LIST_CHARS - 3) + '...';
        return text;
      };

      const variables = {
        '1': config.name,
        '2': formatList(dueToday),
        '3': formatList(dueTomorrow)
      };

      sendWhatsAppTemplate_(waNumber, DAILY_REMINDER_CONTENT_SID, variables);

    } catch (e) {
      Logger.log('sendDailyWhatsAppReminders error for ' + personKey + ': ' + e);
    }
  });
}

function createWhatsAppReminderTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendDailyWhatsAppReminders') ScriptApp.deleteTrigger(t);
  });

  ScriptApp.newTrigger('sendDailyWhatsAppReminders')
    .timeBased()
    .everyDays(1)
    .atHour(11)
    .create();

  ScriptApp.newTrigger('sendDailyWhatsAppReminders')
    .timeBased()
    .everyDays(1)
    .atHour(17)
    .nearMinute(30)
    .create();

  Logger.log('WhatsApp reminder triggers created — fires daily at 11:00 AM and 5:30 PM.');
}

function testWhatsAppSend() {
  const testNumber = '+919355483400';
  const testMessage = '✅ WhatsApp reminder test from Employee Task Management System. If you see this, Twilio credentials are configured correctly!';
  const success = sendWhatsApp_(testNumber, testMessage);
  Logger.log('testWhatsAppSend result: ' + (success ? 'SUCCESS' : 'FAILED — check logs above'));
}

function testTaskAssignedTemplate() {
  const testNumber = '+919355483400';
  const variables = { '1': 'Test User', '2': 'Sample Task', '3': 'High', '4': '20/08/2026' };
  const success = sendWhatsAppTemplate_(testNumber, TASK_ASSIGNED_CONTENT_SID, variables);
  Logger.log('testTaskAssignedTemplate result: ' + (success ? 'SUCCESS' : 'FAILED — check logs above'));
}

function testDailyReminderTemplate() {
  const testNumber = '+919355483400';
  const variables = { '1': 'Test User', '2': 'Sample Task A (High)', '3': 'Sample Task B (Medium)' };
  const success = sendWhatsAppTemplate_(testNumber, DAILY_REMINDER_CONTENT_SID, variables);
  Logger.log('testDailyReminderTemplate result: ' + (success ? 'SUCCESS' : 'FAILED — check logs above'));
}