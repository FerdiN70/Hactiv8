/* ============================================================
   app.js — Daily Planner (To-Do & Habit Tracker)
   Features: task alarms/reminders, habit duration timer,
             WhatsApp reminder integration, localStorage persistence
   Pure vanilla JS — zero external dependencies
   ============================================================ */

'use strict';

/* ══════════════════════════════════════════════════════════════
   1. TYPE DEFINITIONS
══════════════════════════════════════════════════════════════ */

/**
 * @typedef {Object} Task
 * @property {string}  id          - Unique identifier
 * @property {string}  text        - Task description
 * @property {string}  priority    - 'low' | 'medium' | 'high'
 * @property {string}  category    - User category tag (may be empty)
 * @property {boolean} completed   - Completion state
 * @property {string}  createdAt   - YYYY-MM-DD of creation
 * @property {string}  alarmDate   - YYYY-MM-DD for alarm ('' = none)
 * @property {string}  alarmTime   - HH:MM for alarm ('' = none)
 * @property {boolean} alarmFired  - Whether the alarm notification was already sent
 */

/**
 * @typedef {Object} Habit
 * @property {string}  id            - Unique identifier
 * @property {string}  name          - Habit description
 * @property {number}  streak        - Current consecutive-day streak
 * @property {string}  lastChecked   - YYYY-MM-DD of last check-off ('' = never)
 * @property {boolean} doneToday     - Checked off today?
 * @property {number}  timerSeconds  - Current live session seconds (resets on pause/stop)
 * @property {number}  totalSeconds  - Total accumulated seconds (persisted)
 * @property {number}  targetSeconds - Target duration in seconds (0 = no target)
 */

/* ══════════════════════════════════════════════════════════════
   2. STATE
══════════════════════════════════════════════════════════════ */

/** @type {Task[]} */
let tasks = [];

/** @type {Habit[]} */
let habits = [];

/** Active filter for the task list */
let activeFilter = 'all';

/** Saved WhatsApp number (full international, e.g. 628123456789) */
let waNumber = '';

/**
 * ID of the habit whose timer is currently running.
 * Only ONE habit may run at a time — switching auto-pauses the previous one.
 * Runtime-only (not persisted); cleared on page load.
 * @type {string|null}
 */
let activeHabitId = null;

/**
 * The single setInterval handle for the currently-running habit timer.
 * @type {number|null}
 */
let activeIntervalHandle = null;

/** Today's date as YYYY-MM-DD — fixed at module load time */
const TODAY = new Date().toISOString().slice(0, 10);

/**
 * Currently visible page slug: 'dashboard' | 'todo' | 'habits' | 'whatsapp'
 * @type {string}
 */
let activePage = 'dashboard';

/**
 * ID of the task whose ⋯ options dropdown is currently open (null = none).
 * @type {string|null}
 */
let openMenuTaskId = null;

/**
 * ID of the task currently being edited in the modal.
 * @type {string|null}
 */
let editingTaskId = null;

/**
 * ID of the habit whose ⋯ options dropdown is currently open (null = none).
 * @type {string|null}
 */
let openHabitMenuId = null;

/* ══════════════════════════════════════════════════════════════
   3. STORAGE KEYS & PERSISTENCE
══════════════════════════════════════════════════════════════ */

const STORAGE_KEYS = {
  tasks:    'tdh_tasks',
  habits:   'tdh_habits',
  waNumber: 'tdh_wa_number',
};

/** Load all state from localStorage. */
function loadFromStorage() {
  try {
    const rawTasks  = localStorage.getItem(STORAGE_KEYS.tasks);
    const rawHabits = localStorage.getItem(STORAGE_KEYS.habits);
    const rawWa     = localStorage.getItem(STORAGE_KEYS.waNumber);

    tasks    = rawTasks  ? JSON.parse(rawTasks)  : [];
    habits   = rawHabits ? JSON.parse(rawHabits) : [];
    waNumber = rawWa     ? rawWa                 : '';
  } catch (_) {
    // Corrupted data — reset to safe defaults
    tasks    = [];
    habits   = [];
    waNumber = '';
  }

  // Migrate old habits that may lack new fields
  habits = habits.map(h => ({
    timerSeconds:  0,
    totalSeconds:  0,
    targetSeconds: 0,
    ...h,
  }));

  // Reconcile habit streaks for a new day
  habits = habits.map(reconcileHabitStreak);
}

/** Persist current state to localStorage. */
function saveToStorage() {
  localStorage.setItem(STORAGE_KEYS.tasks,  JSON.stringify(tasks));
  localStorage.setItem(STORAGE_KEYS.habits, JSON.stringify(habits));
  localStorage.setItem(STORAGE_KEYS.waNumber, waNumber);
}

/* ══════════════════════════════════════════════════════════════
   4. DATE / TIME HELPERS
══════════════════════════════════════════════════════════════ */

/**
 * Returns the ISO date string for the day before a given YYYY-MM-DD date.
 * @param {string} isoDate
 * @returns {string}
 */
function getPreviousDay(isoDate) {
  const d = new Date(isoDate + 'T00:00:00');
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Converts a total number of seconds into HH:MM:SS string.
 * @param {number} totalSeconds
 * @returns {string}
 */
function formatDuration(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = n => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * Returns a human-readable label for an alarm datetime.
 * @param {string} date YYYY-MM-DD
 * @param {string} time HH:MM
 * @returns {string}
 */
function formatAlarmLabel(date, time) {
  if (!date) return '';
  const d = new Date(`${date}T${time || '00:00'}:00`);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Returns the alarm status for a task.
 * @param {Task} task
 * @returns {'none' | 'upcoming' | 'overdue' | 'done'}
 */
function getAlarmStatus(task) {
  if (!task.alarmDate) return 'none';
  if (task.completed) return 'done';
  const alarmMs = new Date(`${task.alarmDate}T${task.alarmTime || '00:00'}:00`).getTime();
  return Date.now() >= alarmMs ? 'overdue' : 'upcoming';
}

/* ══════════════════════════════════════════════════════════════
   5. HABIT STREAK RECONCILIATION
══════════════════════════════════════════════════════════════ */

/**
 * On app load, check whether a habit's streak should be preserved
 * (checked yesterday) or reset (missed a day). Also resets doneToday
 * when a new day begins.
 * @param {Habit} habit
 * @returns {Habit}
 */
function reconcileHabitStreak(habit) {
  if (!habit.lastChecked) return habit;
  if (habit.lastChecked === TODAY) return habit; // Already handled today

  const yesterday = getPreviousDay(TODAY);

  if (habit.lastChecked === yesterday) {
    // Checked yesterday — streak alive, new day starts unchecked
    return { ...habit, doneToday: false };
  }

  // Missed one or more days — streak broken
  return { ...habit, streak: 0, doneToday: false };
}

/* ══════════════════════════════════════════════════════════════
   6. DOM REFERENCES
══════════════════════════════════════════════════════════════ */

const $ = sel => document.querySelector(sel);

const dom = {
  /* Header */
  date:              $('#js-date'),

  /* Metrics */
  metricDone:        $('#js-metric-done'),
  metricActiveTasks: $('#js-metric-active-tasks'),
  metricStreaks:     $('#js-metric-streaks'),

  /* Task form */
  taskForm:          $('#js-task-form'),
  taskInput:         $('#js-task-input'),
  taskPriority:      $('#js-task-priority'),
  taskCategory:      $('#js-task-category'),
  taskAlarmDate:     $('#js-task-alarm-date'),
  taskAlarmTime:     $('#js-task-alarm-time'),

  /* Task list */
  taskList:          $('#js-task-list'),
  tasksEmpty:        $('#js-tasks-empty'),
  filterTabs:        document.querySelectorAll('.filter-tab'),

  /* Habit form */
  habitForm:         $('#js-habit-form'),
  habitInput:        $('#js-habit-input'),
  habitTargetValue:  $('#js-habit-target-value'),
  habitTargetUnit:   $('#js-habit-target-unit'),

  /* Habit list */
  habitList:         $('#js-habit-list'),
  habitsEmpty:       $('#js-habits-empty'),

  /* WhatsApp */
  waForm:            $('#js-wa-form'),
  waCode:            $('#js-wa-code'),
  waNumberInput:     $('#js-wa-number'),
  waSaved:           $('#js-wa-saved'),
  waQuick:           $('#js-wa-quick'),
  waMsg:             $('#js-wa-msg'),
  waSend:            $('#js-wa-send'),

  /* Toast */
  toast:             $('#js-toast'),
  toastMsg:          $('#js-toast-msg'),
  toastClose:        $('#js-toast-close'),

  /* Edit modal */
  editModal:         $('#js-edit-modal'),
  editForm:          $('#js-edit-form'),
  editText:          $('#js-edit-text'),
  editPriority:      $('#js-edit-priority'),
  editCategory:      $('#js-edit-category'),
  editAlarmDate:     $('#js-edit-alarm-date'),
  editAlarmTime:     $('#js-edit-alarm-time'),
  editModalClose:    $('#js-edit-modal-close'),
  editCancel:        $('#js-edit-cancel'),

  /* Nav */
  navBtns:           document.querySelectorAll('.page-nav__btn'),

  /* Dashboard stat cards */
  dashTasksDone:     $('#js-dash-tasks-done'),
  dashTasksActive:   $('#js-dash-tasks-active'),
  dashOverdue:       $('#js-dash-overdue'),
  dashStreaks:       $('#js-dash-streaks'),

  /* Dashboard lists */
  dashUpcoming:      $('#js-dash-upcoming'),
  dashUpcomingEmpty: $('#js-dash-upcoming-empty'),
  dashOverdueList:   $('#js-dash-overdue-list'),
  dashOverdueEmpty:  $('#js-dash-overdue-empty'),
  dashHabits:        $('#js-dash-habits'),
  dashHabitsEmpty:   $('#js-dash-habits-empty'),
  dashRecent:        $('#js-dash-recent'),
  dashRecentEmpty:   $('#js-dash-recent-empty'),

  /* Dashboard week chart */
  weekChart:         $('#js-week-chart'),
};

/* ══════════════════════════════════════════════════════════════
   7. TOAST NOTIFICATION
══════════════════════════════════════════════════════════════ */

/** Auto-dismiss handle for the toast. */
let toastTimer = null;

/**
 * Show a toast notification message.
 * @param {string} message
 * @param {number} [duration=5000] - Auto-dismiss delay in ms (0 = manual only)
 */
function showToast(message, duration = 5000) {
  dom.toastMsg.textContent = message;
  dom.toast.hidden = false;

  if (toastTimer) clearTimeout(toastTimer);
  if (duration > 0) {
    toastTimer = setTimeout(dismissToast, duration);
  }
}

/** Dismiss the toast. */
function dismissToast() {
  dom.toast.hidden = true;
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
}

/* ══════════════════════════════════════════════════════════════
   8. ALARM POLLING
   Checks every 30 seconds whether any task alarm should fire.
══════════════════════════════════════════════════════════════ */

/**
 * Poll all tasks; fire a notification+WhatsApp for any alarm that just
 * became due and has not been fired yet.
 */
function pollAlarms() {
  let changed = false;

  tasks.forEach(task => {
    if (task.completed || task.alarmFired || !task.alarmDate) return;

    const alarmMs = new Date(`${task.alarmDate}T${task.alarmTime || '00:00'}:00`).getTime();
    if (Date.now() >= alarmMs) {
      task.alarmFired = true;
      changed = true;

      const msg = `⏰ Reminder: "${task.text}" — due ${formatAlarmLabel(task.alarmDate, task.alarmTime)}`;
      showToast(msg, 10000);

      // Browser Notification API (if permission granted)
      if (Notification && Notification.permission === 'granted') {
        new Notification('Daily Planner — Task Reminder', { body: task.text });
      }

      // WhatsApp auto-send if number is saved
      if (waNumber) {
        openWhatsApp(msg);
      }
    }
  });

  if (changed) {
    saveToStorage();
    renderTasks(); // Refresh alarm badges
  }
}

/** Request browser notification permission on first interaction. */
function requestNotificationPermission() {
  if (Notification && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

/* ══════════════════════════════════════════════════════════════
   9. WHATSAPP HELPERS
══════════════════════════════════════════════════════════════ */

/**
 * Open a pre-filled WhatsApp message in a new tab.
 * @param {string} message - The text to pre-fill.
 */
function openWhatsApp(message) {
  if (!waNumber) return;
  const url = `https://wa.me/${waNumber}?text=${encodeURIComponent(message)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Update the WhatsApp section UI to reflect the saved number. */
function renderWaSection() {
  if (waNumber) {
    dom.waSaved.textContent = `✓ Saved: +${waNumber}`;
    dom.waSaved.hidden      = false;
    dom.waQuick.hidden      = false;
  } else {
    dom.waSaved.hidden = true;
    dom.waQuick.hidden = true;
  }

  // Pre-fill code and number inputs from saved state
  if (waNumber) {
    // We store the full number; we show it split back in the inputs
    // just leave as-is — user re-enters to edit
  }
}

/* ══════════════════════════════════════════════════════════════
   10. RENDERING — Tasks
══════════════════════════════════════════════════════════════ */

/**
 * Returns the filtered subset of tasks based on the active tab.
 * @returns {Task[]}
 */
function getFilteredTasks() {
  switch (activeFilter) {
    case 'active':    return tasks.filter(t => !t.completed);
    case 'completed': return tasks.filter(t =>  t.completed);
    case 'overdue':   return tasks.filter(t => !t.completed && getAlarmStatus(t) === 'overdue');
    default:          return tasks;
  }
}

/** Re-render the entire task list. */
function renderTasks() {
  const filtered = getFilteredTasks();
  dom.taskList.innerHTML = '';

  if (filtered.length === 0) {
    dom.tasksEmpty.hidden = false;
    return;
  }

  dom.tasksEmpty.hidden = true;
  const fragment = document.createDocumentFragment();
  filtered.forEach(task => fragment.appendChild(buildTaskItem(task)));
  dom.taskList.appendChild(fragment);
}

/**
 * Build an <li> element for a single task.
 * @param {Task} task
 * @returns {HTMLLIElement}
 */
function buildTaskItem(task) {
  const alarmStatus = getAlarmStatus(task);

  const li = document.createElement('li');
  // Compose CSS classes based on state
  const classes = ['task-item'];
  if (task.completed)              classes.push('task-item--completed');
  if (alarmStatus === 'overdue')   classes.push('task-item--overdue');
  if (alarmStatus === 'upcoming')  classes.push('task-item--alarm');
  li.className = classes.join(' ');
  li.dataset.id = task.id;

  /* ── Checkbox ── */
  const checkbox = document.createElement('input');
  checkbox.type        = 'checkbox';
  checkbox.className   = 'task-checkbox';
  checkbox.checked     = task.completed;
  checkbox.id          = `task-cb-${task.id}`;
  checkbox.setAttribute('aria-label', `Mark "${task.text}" as ${task.completed ? 'active' : 'completed'}`);
  checkbox.addEventListener('change', () => toggleTask(task.id));

  /* ── Task body ── */
  const body = document.createElement('div');
  body.className = 'task-body';

  const label = document.createElement('label');
  label.htmlFor   = `task-cb-${task.id}`;
  label.className = 'task-text';
  label.textContent = task.text;

  /* ── Meta row (priority + category + alarm badge) ── */
  const meta = document.createElement('div');
  meta.className = 'task-meta';

  // Priority badge
  const badge = document.createElement('span');
  badge.className   = `priority-badge priority-badge--${task.priority}`;
  badge.textContent = task.priority.charAt(0).toUpperCase() + task.priority.slice(1);
  meta.appendChild(badge);

  // Category tag
  if (task.category) {
    const cat = document.createElement('span');
    cat.className   = 'category-tag';
    cat.textContent = task.category;
    meta.appendChild(cat);
  }

  // Alarm badge
  if (task.alarmDate) {
    const alarmBadge = document.createElement('span');
    const badgeClass = alarmStatus === 'overdue'  ? 'alarm-badge--overdue'
                     : alarmStatus === 'upcoming' ? 'alarm-badge--upcoming'
                     :                              'alarm-badge--done';
    alarmBadge.className = `alarm-badge ${badgeClass}`;
    const icon = alarmStatus === 'overdue' ? '🔴' : alarmStatus === 'done' ? '✅' : '🔔';
    alarmBadge.textContent = `${icon} ${formatAlarmLabel(task.alarmDate, task.alarmTime)}`;
    meta.appendChild(alarmBadge);
  }

  body.appendChild(label);
  body.appendChild(meta);

  /* ── Options menu (⋯ button + dropdown) ── */
  const optionsWrap = document.createElement('div');
  optionsWrap.className = 'task-options';

  // ⋯ trigger button
  const optBtn = document.createElement('button');
  optBtn.type      = 'button';
  optBtn.className = 'btn btn--options';
  optBtn.setAttribute('aria-label', `Options for task: ${task.text}`);
  optBtn.setAttribute('aria-haspopup', 'true');
  optBtn.setAttribute('aria-expanded', 'false');
  optBtn.textContent = '•••';
  optBtn.addEventListener('click', e => {
    e.stopPropagation();
    toggleTaskMenu(task.id);
  });

  // Dropdown menu
  const menu = document.createElement('div');
  menu.className = 'task-options__menu';
  menu.id        = `task-menu-${task.id}`;
  menu.setAttribute('role', 'menu');

  // Edit option
  const editItem = document.createElement('button');
  editItem.type      = 'button';
  editItem.className = 'task-options__item';
  editItem.setAttribute('role', 'menuitem');
  editItem.innerHTML = `<svg class="icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/></svg> Edit`;
  editItem.addEventListener('click', e => {
    e.stopPropagation();
    closeTaskMenu();
    openEditModal(task.id);
  });

  // Delete option
  const delItem = document.createElement('button');
  delItem.type      = 'button';
  delItem.className = 'task-options__item task-options__item--danger';
  delItem.setAttribute('role', 'menuitem');
  delItem.innerHTML = `<svg class="icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 012 0v6a1 1 0 11-2 0V8z" clip-rule="evenodd"/></svg> Delete`;
  delItem.addEventListener('click', e => {
    e.stopPropagation();
    closeTaskMenu();
    deleteTask(task.id);
  });

  menu.appendChild(editItem);
  menu.appendChild(delItem);
  optionsWrap.appendChild(optBtn);
  optionsWrap.appendChild(menu);

  li.appendChild(checkbox);
  li.appendChild(body);
  li.appendChild(optionsWrap);

  return li;
}

/* ══════════════════════════════════════════════════════════════
   11. RENDERING — Habits (with per-item timer)
══════════════════════════════════════════════════════════════ */

/** Re-render the entire habit list. */
function renderHabits() {
  // Stop the running timer before re-render; the interval is restarted
  // by timerStart() — accumulated seconds are already saved in state.
  _stopActiveInterval();

  dom.habitList.innerHTML = '';

  if (habits.length === 0) {
    dom.habitsEmpty.hidden = false;
    return;
  }

  dom.habitsEmpty.hidden = true;
  const fragment = document.createDocumentFragment();
  habits.forEach(habit => fragment.appendChild(buildHabitItem(habit)));
  dom.habitList.appendChild(fragment);

  // If a habit was active before the re-render, restart its interval
  if (activeHabitId) {
    _startInterval(activeHabitId);
    _applyActiveClass(activeHabitId, true);
  }
}

/**
 * Build an <li> element for a single habit including timer row + progress.
 * @param {Habit} habit
 * @returns {HTMLLIElement}
 */
function buildHabitItem(habit) {
  const isActive = habit.id === activeHabitId;

  const li = document.createElement('li');
  const classes = ['habit-item'];
  if (habit.doneToday) classes.push('habit-item--done');
  if (isActive)        classes.push('habit-item--active');
  li.className  = classes.join(' ');
  li.dataset.id = habit.id;

  // Clicking anywhere on the card toggles the timer (start/pause)
  li.addEventListener('click', e => {
    // Ignore clicks that originate from buttons or checkboxes
    if (e.target.closest('button') || e.target.closest('input[type="checkbox"]')) return;
    timerToggle(habit.id);
  });

  /* ── TOP ROW: checkbox, name, streak, delete ── */
  const topRow = document.createElement('div');
  topRow.className = 'habit-item__top';

  const checkbox = document.createElement('input');
  checkbox.type      = 'checkbox';
  checkbox.className = 'habit-checkbox';
  checkbox.checked   = habit.doneToday;
  checkbox.id        = `habit-cb-${habit.id}`;
  checkbox.setAttribute('aria-label', `Mark habit "${habit.name}" as done today`);
  checkbox.addEventListener('change', () => toggleHabit(habit.id));

  const label = document.createElement('label');
  label.htmlFor     = `habit-cb-${habit.id}`;
  label.className   = 'habit-name';
  label.textContent = habit.name;

  const streakBadge = document.createElement('span');
  streakBadge.className = 'streak-badge';
  streakBadge.setAttribute('aria-label', `${habit.streak} day streak`);
  streakBadge.textContent = `🔥 ${habit.streak}d`;

  // ⋯ options menu
  const habitOptionsWrap = document.createElement('div');
  habitOptionsWrap.className = 'habit-options';

  const habitOptBtn = document.createElement('button');
  habitOptBtn.type      = 'button';
  habitOptBtn.className = 'btn btn--options';
  habitOptBtn.setAttribute('aria-label', `Options for habit: ${habit.name}`);
  habitOptBtn.setAttribute('aria-haspopup', 'true');
  habitOptBtn.setAttribute('aria-expanded', 'false');
  habitOptBtn.textContent = '•••';
  habitOptBtn.addEventListener('click', e => {
    e.stopPropagation();
    _toggleHabitMenu(habit.id);
  });

  const habitMenu = document.createElement('div');
  habitMenu.className = 'task-options__menu';    // reuse task menu styles
  habitMenu.id        = `habit-menu-${habit.id}`;
  habitMenu.setAttribute('role', 'menu');

  const habitDelItem = document.createElement('button');
  habitDelItem.type      = 'button';
  habitDelItem.className = 'task-options__item task-options__item--danger';
  habitDelItem.setAttribute('role', 'menuitem');
  habitDelItem.innerHTML = `<svg class="icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm4 0a1 1 0 012 0v6a1 1 0 11-2 0V8z" clip-rule="evenodd"/></svg> Delete`;
  habitDelItem.addEventListener('click', e => {
    e.stopPropagation();
    _closeHabitMenu();
    deleteHabit(habit.id);
  });

  habitMenu.appendChild(habitDelItem);
  habitOptionsWrap.appendChild(habitOptBtn);
  habitOptionsWrap.appendChild(habitMenu);

  topRow.appendChild(checkbox);
  topRow.appendChild(label);
  topRow.appendChild(streakBadge);
  topRow.appendChild(habitOptionsWrap);

  /* ── TIMER ROW ── */
  const timerRow = document.createElement('div');
  timerRow.className = 'habit-timer';

  /* ── Progress bar ── */
  if (habit.targetSeconds > 0) {
    const track = document.createElement('div');
    track.className = 'habit-progress-track';

    const fill = document.createElement('div');
    fill.id        = `habit-fill-${habit.id}`;
    fill.className = 'habit-progress-fill';
    _updateProgressFill(fill, habit.totalSeconds, habit.targetSeconds);

    track.appendChild(fill);
    timerRow.appendChild(track);
  }

  /* ── Controls row: display + buttons + progress label ── */
  const controls = document.createElement('div');
  controls.className = 'habit-timer__controls';

  // Session timer display (HH:MM:SS)
  const timerDisplay = document.createElement('span');
  timerDisplay.className   = 'timer-display';
  timerDisplay.id          = `timer-display-${habit.id}`;
  timerDisplay.textContent = formatDuration(habit.timerSeconds);

  // Start/Pause toggle button
  const startBtn = document.createElement('button');
  startBtn.type      = 'button';
  startBtn.className = `btn btn--timer${isActive ? ' active' : ''}`;
  startBtn.id        = `timer-start-${habit.id}`;
  startBtn.textContent = isActive ? 'Pause' : 'Start';
  startBtn.addEventListener('click', e => { e.stopPropagation(); timerToggle(habit.id); });

  // Reset button
  const resetBtn = document.createElement('button');
  resetBtn.type        = 'button';
  resetBtn.className   = 'btn btn--timer';
  resetBtn.textContent = 'Reset';
  resetBtn.addEventListener('click', e => { e.stopPropagation(); timerReset(habit.id); });

  // Progress label: "accumulated / target" or just "Total: HH:MM:SS"
  const progressLabel = document.createElement('span');
  progressLabel.id        = `timer-progress-${habit.id}`;
  progressLabel.className = 'timer-progress-label';
  _updateProgressLabel(progressLabel, habit.totalSeconds, habit.targetSeconds);

  controls.appendChild(timerDisplay);
  controls.appendChild(startBtn);
  controls.appendChild(resetBtn);
  controls.appendChild(progressLabel);

  timerRow.appendChild(controls);

  li.appendChild(topRow);
  li.appendChild(timerRow);

  return li;
}

/* ══════════════════════════════════════════════════════════════
   12. TIMER LOGIC  (single-active rule)
══════════════════════════════════════════════════════════════ */

/* ── Private helpers ── */

/**
 * Stop the global interval without touching state.
 * Safe to call even when no interval is running.
 */
function _stopActiveInterval() {
  if (activeIntervalHandle !== null) {
    clearInterval(activeIntervalHandle);
    activeIntervalHandle = null;
  }
}

/**
 * Start the 1-second tick for `id`. Does NOT change `activeHabitId`.
 * @param {string} id
 */
function _startInterval(id) {
  _stopActiveInterval();

  activeIntervalHandle = setInterval(() => {
    const habit = habits.find(h => h.id === id);
    if (!habit) { _stopActiveInterval(); return; }

    habit.timerSeconds += 1;

    // Update session display in-place (avoids re-render flicker)
    const display = document.getElementById(`timer-display-${id}`);
    if (display) display.textContent = formatDuration(habit.timerSeconds);

    // Update progress bar and label in-place
    if (habit.targetSeconds > 0) {
      const fill = document.getElementById(`habit-fill-${id}`);
      if (fill) _updateProgressFill(fill, habit.totalSeconds + habit.timerSeconds, habit.targetSeconds);
    }
    const lbl = document.getElementById(`timer-progress-${id}`);
    if (lbl) _updateProgressLabel(lbl, habit.totalSeconds + habit.timerSeconds, habit.targetSeconds);

    // ── Auto-complete: if accumulated time >= target and not yet done ──
    if (
      habit.targetSeconds > 0 &&
      !habit.doneToday &&
      (habit.totalSeconds + habit.timerSeconds) >= habit.targetSeconds
    ) {
      // Flush current session then mark done
      _stopActiveInterval();
      activeHabitId = null;
      _flushTimer(habit);
      habit.doneToday   = true;
      habit.lastChecked = TODAY;
      habit.streak     += 1;
      saveToStorage();
      showToast(`🎉 "${habit.name}" — target reached! Marked as done.`, 5000);
      renderHabits();
      renderMetrics();
      if (activePage === 'dashboard') renderDashboard();
      return;
    }

    // Auto-save every 10 s
    if (habit.timerSeconds % 10 === 0) saveToStorage();
  }, 1000);
}

/**
 * Apply or remove the visual active state on a habit list item.
 * Updates the Start/Pause button label too.
 * @param {string} id
 * @param {boolean} active
 */
function _applyActiveClass(id, active) {
  const li  = dom.habitList.querySelector(`[data-id="${id}"]`);
  const btn = document.getElementById(`timer-start-${id}`);
  if (li)  li.classList.toggle('habit-item--active', active);
  if (btn) {
    btn.classList.toggle('active', active);
    btn.textContent = active ? 'Pause' : 'Start';
  }
}

/**
 * Flush timerSeconds into totalSeconds for a habit and reset the session.
 * Saves to localStorage.
 * @param {Habit} habit
 */
function _flushTimer(habit) {
  habit.totalSeconds += habit.timerSeconds;
  habit.timerSeconds  = 0;
  saveToStorage();

  // Update the session display to 00:00:00
  const display = document.getElementById(`timer-display-${habit.id}`);
  if (display) display.textContent = formatDuration(0);

  // Update progress label with new total
  const lbl = document.getElementById(`timer-progress-${habit.id}`);
  if (lbl) _updateProgressLabel(lbl, habit.totalSeconds, habit.targetSeconds);

  // Update progress fill with new total
  if (habit.targetSeconds > 0) {
    const fill = document.getElementById(`habit-fill-${habit.id}`);
    if (fill) _updateProgressFill(fill, habit.totalSeconds, habit.targetSeconds);
  }
}

/**
 * Set the width % and colour class on a progress fill element.
 * @param {HTMLElement} fill
 * @param {number} accumulatedSeconds - totalSeconds + timerSeconds (live)
 * @param {number} targetSeconds
 */
function _updateProgressFill(fill, accumulatedSeconds, targetSeconds) {
  if (targetSeconds <= 0) return;
  const pct = Math.min(100, (accumulatedSeconds / targetSeconds) * 100);
  fill.style.width = `${pct}%`;
  fill.classList.toggle('habit-progress-fill--complete', accumulatedSeconds >= targetSeconds);
}

/**
 * Set the text of the progress label.
 * Format: "HH:MM:SS / HH:MM:SS" when target exists, else "Total: HH:MM:SS"
 * @param {HTMLElement} lbl
 * @param {number} accumulatedSeconds
 * @param {number} targetSeconds
 */
function _updateProgressLabel(lbl, accumulatedSeconds, targetSeconds) {
  if (targetSeconds > 0) {
    const reached = accumulatedSeconds >= targetSeconds;
    lbl.textContent = `${formatDuration(accumulatedSeconds)} / ${formatDuration(targetSeconds)}`;
    lbl.classList.toggle('timer-progress-label--done', reached);
  } else {
    lbl.textContent = `Total: ${formatDuration(accumulatedSeconds)}`;
    lbl.classList.remove('timer-progress-label--done');
  }
}

/* ── Public timer API ── */

/**
 * Toggle start/pause for a habit.
 * Enforces the single-active rule: pauses any other running habit first.
 * Clicking the name/card or the Start button both call this.
 * @param {string} id
 */
function timerToggle(id) {
  if (activeHabitId === id) {
    // ── Pause the currently-running habit ──
    _stopActiveInterval();
    const habit = habits.find(h => h.id === id);
    if (habit) _flushTimer(habit);
    _applyActiveClass(id, false);
    activeHabitId = null;
  } else {
    // ── Pause previous habit (if any) then start this one ──
    if (activeHabitId) {
      _stopActiveInterval();
      const prev = habits.find(h => h.id === activeHabitId);
      if (prev) _flushTimer(prev);
      _applyActiveClass(activeHabitId, false);
    }
    activeHabitId = id;
    _startInterval(id);
    _applyActiveClass(id, true);
  }
}

/**
 * Reset the current session seconds for a habit.
 * Does NOT clear the accumulated total; stops the timer if running.
 * @param {string} id
 */
function timerReset(id) {
  // If this habit is currently active, stop its interval
  if (activeHabitId === id) {
    _stopActiveInterval();
    activeHabitId = null;
    _applyActiveClass(id, false);
  }

  const habit = habits.find(h => h.id === id);
  if (!habit) return;

  habit.timerSeconds = 0;
  saveToStorage();

  const display = document.getElementById(`timer-display-${id}`);
  if (display) display.textContent = formatDuration(0);

  // Refresh progress label (total unchanged, just session reset)
  const lbl = document.getElementById(`timer-progress-${id}`);
  if (lbl) _updateProgressLabel(lbl, habit.totalSeconds, habit.targetSeconds);
}

/* ══════════════════════════════════════════════════════════════
   13. RENDERING — Metrics & Date
══════════════════════════════════════════════════════════════ */

/** Refresh the three summary metric cards. */
function renderMetrics() {
  const doneToday    = tasks.filter(t => t.completed && t.createdAt === TODAY).length;
  const activeTasks  = tasks.filter(t => !t.completed).length;
  const activeStreaks = habits.filter(h => h.streak > 0).length;

  dom.metricDone.textContent        = doneToday;
  dom.metricActiveTasks.textContent = activeTasks;
  dom.metricStreaks.textContent      = activeStreaks;
}

/** Display today's formatted date in the header. */
function renderDate() {
  dom.date.textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

/* ══════════════════════════════════════════════════════════════
   14a. TASK OPTIONS MENU
══════════════════════════════════════════════════════════════ */

/**
 * Toggle the ⋯ dropdown for a given task.
 * If another task's menu is open, close it first.
 * @param {string} id
 */
function toggleTaskMenu(id) {
  if (openMenuTaskId === id) {
    closeTaskMenu();
    return;
  }
  // Close any other open menu
  if (openMenuTaskId) closeTaskMenu();

  openMenuTaskId = id;
  const menu   = document.getElementById(`task-menu-${id}`);
  const optBtn = menu && menu.previousElementSibling;
  if (menu)   menu.classList.add('task-options__menu--open');
  if (optBtn) optBtn.setAttribute('aria-expanded', 'true');
}

/** Close whatever task options menu is currently open. */
function closeTaskMenu() {
  if (!openMenuTaskId) return;
  const menu   = document.getElementById(`task-menu-${openMenuTaskId}`);
  const optBtn = menu && menu.previousElementSibling;
  if (menu)   menu.classList.remove('task-options__menu--open');
  if (optBtn) optBtn.setAttribute('aria-expanded', 'false');
  openMenuTaskId = null;
}

/* ══════════════════════════════════════════════════════════════
   14b. TASK EDIT MODAL
══════════════════════════════════════════════════════════════ */

/**
 * Open the edit modal pre-filled with the task's current values.
 * @param {string} id
 */
function openEditModal(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;

  editingTaskId = id;

  // Pre-fill all fields
  dom.editText.value      = task.text;
  dom.editPriority.value  = task.priority;
  dom.editCategory.value  = task.category;
  dom.editAlarmDate.value = task.alarmDate  || '';
  dom.editAlarmTime.value = task.alarmTime  || '';

  dom.editModal.hidden = false;
  dom.editText.focus();
}

/** Close the edit modal and clear editing state. */
function closeEditModal() {
  dom.editModal.hidden = true;
  editingTaskId = null;
}

/**
 * Save changes from the edit modal back to the task.
 * @param {Event} e
 */
function handleEditSave(e) {
  e.preventDefault();

  const task = tasks.find(t => t.id === editingTaskId);
  if (!task) { closeEditModal(); return; }

  const newText = dom.editText.value.trim();
  if (!newText) return;  // silent guard — required field

  task.text      = newText;
  task.priority  = dom.editPriority.value;
  task.category  = dom.editCategory.value.trim();
  task.alarmDate = dom.editAlarmDate.value;
  task.alarmTime = dom.editAlarmTime.value;

  // If the alarm date/time changed, allow it to fire again
  if (task.alarmFired) {
    const newAlarmMs = task.alarmDate
      ? new Date(`${task.alarmDate}T${task.alarmTime || '00:00'}:00`).getTime()
      : 0;
    if (newAlarmMs > Date.now()) task.alarmFired = false;
  }

  saveToStorage();
  closeEditModal();
  renderTasks();
  renderMetrics();
  if (activePage === 'dashboard') renderDashboard();
  showToast('Task updated.', 2500);
}

/* ══════════════════════════════════════════════════════════════
   14. TASK ACTIONS
══════════════════════════════════════════════════════════════ */

/**
 * Handle task form submission — add a new task.
 * @param {Event} e
 */
function handleAddTask(e) {
  e.preventDefault();
  requestNotificationPermission();

  const text      = dom.taskInput.value.trim();
  const priority  = dom.taskPriority.value;
  const category  = dom.taskCategory.value.trim();
  const alarmDate = dom.taskAlarmDate.value;   // YYYY-MM-DD or ''
  const alarmTime = dom.taskAlarmTime.value;   // HH:MM or ''

  if (!text) return;

  /** @type {Task} */
  const newTask = {
    id:         `task-${Date.now()}`,
    text,
    priority,
    category,
    completed:  false,
    createdAt:  TODAY,
    alarmDate,
    alarmTime,
    alarmFired: false,
  };

  tasks.unshift(newTask);
  saveToStorage();
  renderTasks();
  renderMetrics();
  if (activePage === 'dashboard') renderDashboard();

  // Reset form
  dom.taskInput.value    = '';
  dom.taskCategory.value = '';
  dom.taskPriority.value = 'medium';
  dom.taskAlarmDate.value = '';
  dom.taskAlarmTime.value = '';
  dom.taskInput.focus();
}

/**
 * Toggle the completed state of a task.
 * @param {string} id
 */
function toggleTask(id) {
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  task.completed = !task.completed;
  saveToStorage();
  renderTasks();
  renderMetrics();
  if (activePage === 'dashboard') renderDashboard();
}

/**
 * Permanently remove a task.
 * @param {string} id
 */
function deleteTask(id) {
  tasks = tasks.filter(t => t.id !== id);
  saveToStorage();
  renderTasks();
  renderMetrics();
  if (activePage === 'dashboard') renderDashboard();
}

/* ══════════════════════════════════════════════════════════════
   14c. HABIT OPTIONS MENU
══════════════════════════════════════════════════════════════ */

/**
 * Toggle the ⋯ dropdown for a given habit.
 * @param {string} id
 */
function _toggleHabitMenu(id) {
  if (openHabitMenuId === id) { _closeHabitMenu(); return; }
  if (openHabitMenuId) _closeHabitMenu();

  openHabitMenuId = id;
  const menu   = document.getElementById(`habit-menu-${id}`);
  const optBtn = menu && menu.previousElementSibling;
  if (menu)   menu.classList.add('task-options__menu--open');
  if (optBtn) optBtn.setAttribute('aria-expanded', 'true');
}

/** Close the habit options menu. */
function _closeHabitMenu() {
  if (!openHabitMenuId) return;
  const menu   = document.getElementById(`habit-menu-${openHabitMenuId}`);
  const optBtn = menu && menu.previousElementSibling;
  if (menu)   menu.classList.remove('task-options__menu--open');
  if (optBtn) optBtn.setAttribute('aria-expanded', 'false');
  openHabitMenuId = null;
}

/* ══════════════════════════════════════════════════════════════
   15. HABIT ACTIONS
══════════════════════════════════════════════════════════════ */

/**
 * Handle habit form submission — add a new habit.
 * @param {Event} e
 */
function handleAddHabit(e) {
  e.preventDefault();

  const name = dom.habitInput.value.trim();
  if (!name) return;

  // Parse target duration — convert to seconds (0 = no target)
  const rawValue = parseInt(dom.habitTargetValue.value, 10);
  const unit     = dom.habitTargetUnit.value;           // 'min' or 'hr'
  let targetSeconds = 0;
  if (!isNaN(rawValue) && rawValue > 0) {
    targetSeconds = unit === 'hr' ? rawValue * 3600 : rawValue * 60;
  }

  /** @type {Habit} */
  const newHabit = {
    id:            `habit-${Date.now()}`,
    name,
    streak:        0,
    lastChecked:   '',
    doneToday:     false,
    timerSeconds:  0,
    totalSeconds:  0,
    targetSeconds,
  };

  habits.push(newHabit);
  saveToStorage();
  renderHabits();
  renderMetrics();
  if (activePage === 'dashboard') renderDashboard();

  dom.habitInput.value       = '';
  dom.habitTargetValue.value = '';
  dom.habitInput.focus();
}

/**
 * Toggle today's check-off for a habit and update the streak.
 * @param {string} id
 */
function toggleHabit(id) {
  const habit = habits.find(h => h.id === id);
  if (!habit) return;

  if (!habit.doneToday) {
    // Checking off for today
    habit.doneToday   = true;
    habit.lastChecked = TODAY;
    habit.streak     += 1;
  } else {
    // Undo same-day check-off
    habit.doneToday   = false;
    habit.lastChecked = getPreviousDay(TODAY);
    habit.streak      = Math.max(0, habit.streak - 1);
  }

  saveToStorage();
  renderHabits();
  renderMetrics();
  if (activePage === 'dashboard') renderDashboard();
}

/**
 * Permanently remove a habit and stop its timer.
 * @param {string} id
 */
function deleteHabit(id) {
  // Stop global timer if this habit is the active one
  if (activeHabitId === id) {
    _stopActiveInterval();
    activeHabitId = null;
  }

  habits = habits.filter(h => h.id !== id);
  saveToStorage();
  renderHabits();
  renderMetrics();
  if (activePage === 'dashboard') renderDashboard();
}

/* ══════════════════════════════════════════════════════════════
   16. FILTER TAB LOGIC
══════════════════════════════════════════════════════════════ */

/**
 * Handle a filter tab click.
 * @param {Event} e
 */
function handleFilterClick(e) {
  const tab    = e.currentTarget;
  const filter = tab.dataset.filter;
  if (filter === activeFilter) return;

  activeFilter = filter;

  dom.filterTabs.forEach(t => {
    const isActive = t.dataset.filter === filter;
    t.classList.toggle('filter-tab--active', isActive);
    t.setAttribute('aria-selected', String(isActive));
  });

  renderTasks();
}

/* ══════════════════════════════════════════════════════════════
   17. WHATSAPP ACTIONS
══════════════════════════════════════════════════════════════ */

/**
 * Save the WhatsApp number from the form.
 * @param {Event} e
 */
function handleSaveWa(e) {
  e.preventDefault();

  const code   = dom.waCode.value.trim().replace(/^\+/, '');  // strip leading +
  const number = dom.waNumberInput.value.trim().replace(/^0/, ''); // strip leading 0

  if (!code || !number) {
    showToast('Please enter both a country code and phone number.', 4000);
    return;
  }

  waNumber = code + number;  // e.g. 628123456789
  saveToStorage();
  renderWaSection();
  showToast(`WhatsApp number saved: +${waNumber}`, 3000);
}

/**
 * Handle the quick-send WhatsApp button.
 */
function handleQuickSend() {
  const msg = dom.waMsg.value.trim();
  if (!msg) {
    showToast('Please type a message to send.', 3000);
    return;
  }
  openWhatsApp(msg);
}

/* ══════════════════════════════════════════════════════════════
   18. NAV / PAGE ROUTING
══════════════════════════════════════════════════════════════ */

/**
 * Show the requested page, hide all others, update nav active state.
 * @param {string} page - 'dashboard' | 'todo' | 'habits' | 'whatsapp'
 */
function navigateTo(page) {
  activePage = page;

  // Show/hide page <div>s
  ['dashboard', 'todo', 'habits', 'whatsapp'].forEach(p => {
    const el = document.getElementById(`page-${p}`);
    if (el) el.classList.toggle('page--hidden', p !== page);
  });

  // Update nav button states
  dom.navBtns.forEach(btn => {
    const isActive = btn.dataset.page === page;
    btn.classList.toggle('page-nav__btn--active', isActive);
    btn.setAttribute('aria-selected', String(isActive));
  });

  // Refresh dashboard whenever it becomes visible
  if (page === 'dashboard') renderDashboard();
}

/* ══════════════════════════════════════════════════════════════
   19. DASHBOARD RENDERING
══════════════════════════════════════════════════════════════ */

/**
 * Full dashboard re-render — called on nav to dashboard and after any
 * state mutation (task add/toggle/delete, habit toggle/delete).
 */
function renderDashboard() {
  _renderDashStats();
  _renderDashUpcoming();
  _renderDashOverdue();
  _renderDashHabits();
  _renderWeekChart();
  _renderDashRecent();
}

/* ── 19a. Quick stat numbers ── */
function _renderDashStats() {
  const doneToday    = tasks.filter(t => t.completed && t.createdAt === TODAY).length;
  const activeTasks  = tasks.filter(t => !t.completed).length;
  const overdueCount = tasks.filter(t => !t.completed && getAlarmStatus(t) === 'overdue').length;
  const streaks      = habits.filter(h => h.streak > 0).length;

  dom.dashTasksDone.textContent   = doneToday;
  dom.dashTasksActive.textContent = activeTasks;
  dom.dashOverdue.textContent     = overdueCount;
  dom.dashStreaks.textContent      = streaks;
}

/* ── 19b. Upcoming reminders (next 7 days, sorted by alarm datetime) ── */
function _renderDashUpcoming() {
  const now     = Date.now();
  const in7days = now + 7 * 24 * 3600 * 1000;

  const upcoming = tasks
    .filter(t => {
      if (t.completed || !t.alarmDate) return false;
      const ms = new Date(`${t.alarmDate}T${t.alarmTime || '00:00'}:00`).getTime();
      return ms > now && ms <= in7days;
    })
    .sort((a, b) => {
      const ma = new Date(`${a.alarmDate}T${a.alarmTime || '00:00'}:00`).getTime();
      const mb = new Date(`${b.alarmDate}T${b.alarmTime || '00:00'}:00`).getTime();
      return ma - mb;
    })
    .slice(0, 8); // cap at 8 items

  dom.dashUpcoming.innerHTML = '';
  dom.dashUpcomingEmpty.hidden = upcoming.length > 0;

  upcoming.forEach(t => {
    const li = document.createElement('li');
    li.className = 'dash-item dash-item--upcoming';
    li.innerHTML = `
      <span class="dash-item__icon">🔔</span>
      <div class="dash-item__body">
        <div class="dash-item__title">${_escHtml(t.text)}</div>
        <div class="dash-item__meta">${formatAlarmLabel(t.alarmDate, t.alarmTime)}${t.category ? ' · ' + _escHtml(t.category) : ''}</div>
      </div>`;
    dom.dashUpcoming.appendChild(li);
  });
}

/* ── 19c. Overdue tasks ── */
function _renderDashOverdue() {
  const overdue = tasks
    .filter(t => !t.completed && getAlarmStatus(t) === 'overdue')
    .sort((a, b) => {
      const ma = new Date(`${a.alarmDate}T${a.alarmTime || '00:00'}:00`).getTime();
      const mb = new Date(`${b.alarmDate}T${b.alarmTime || '00:00'}:00`).getTime();
      return ma - mb;
    })
    .slice(0, 8);

  dom.dashOverdueList.innerHTML = '';
  dom.dashOverdueEmpty.hidden   = overdue.length > 0;

  overdue.forEach(t => {
    const li = document.createElement('li');
    li.className = 'dash-item dash-item--overdue';
    li.innerHTML = `
      <span class="dash-item__icon">🔴</span>
      <div class="dash-item__body">
        <div class="dash-item__title">${_escHtml(t.text)}</div>
        <div class="dash-item__meta">Due: ${formatAlarmLabel(t.alarmDate, t.alarmTime)}</div>
      </div>`;
    dom.dashOverdueList.appendChild(li);
  });
}

/* ── 19d. Habit progress summary ── */
function _renderDashHabits() {
  dom.dashHabits.innerHTML = '';
  dom.dashHabitsEmpty.hidden = habits.length > 0;

  habits.forEach(habit => {
    const accumulated = habit.totalSeconds + habit.timerSeconds;
    const hasTarget   = habit.targetSeconds > 0;
    const pct         = hasTarget ? Math.min(100, (accumulated / habit.targetSeconds) * 100) : 0;
    const done        = (hasTarget && accumulated >= habit.targetSeconds) || habit.doneToday;

    // Each habit gets its own mini-card
    const card = document.createElement('div');
    card.className = `dash-habit-card${done ? ' dash-habit-card--done' : ''}`;

    /* ── Top row: name + streak ── */
    const topRow = document.createElement('div');
    topRow.className = 'dash-habit-card__top';

    const nameEl = document.createElement('span');
    nameEl.className   = 'dash-habit-name';
    nameEl.textContent = habit.name;

    const streakEl = document.createElement('span');
    streakEl.className   = 'dash-habit-streak';
    streakEl.textContent = `🔥 ${habit.streak}d`;

    topRow.appendChild(nameEl);
    topRow.appendChild(streakEl);
    card.appendChild(topRow);

    /* ── Progress bar (only if target set) ── */
    if (hasTarget) {
      const barWrap = document.createElement('div');
      barWrap.className = 'dash-habit-bar-wrap';
      const fill = document.createElement('div');
      const fillDone = pct >= 100;
      fill.className   = `dash-habit-bar-fill${fillDone ? ' dash-habit-bar-fill--done' : ''}`;
      fill.style.width = `${pct}%`;
      barWrap.appendChild(fill);
      card.appendChild(barWrap);
    }

    /* ── Meta line: time / status ── */
    const metaEl = document.createElement('div');
    metaEl.className = 'dash-habit-meta';

    if (hasTarget) {
      metaEl.textContent = `${formatDuration(accumulated)} / ${formatDuration(habit.targetSeconds)}`;
    } else if (accumulated > 0) {
      metaEl.textContent = `Total: ${formatDuration(accumulated)}`;
    } else {
      metaEl.textContent = 'Not started yet';
    }

    // Done badge on the right
    if (done) {
      const doneBadge = document.createElement('span');
      doneBadge.className   = 'dash-habit-done-badge';
      doneBadge.textContent = '✓ Done';
      metaEl.appendChild(doneBadge);
    }

    card.appendChild(metaEl);
    dom.dashHabits.appendChild(card);
  });
}

/* ── 19e. 7-day task completion bar chart ── */
function _renderWeekChart() {
  dom.weekChart.innerHTML = '';

  // Build the past 7 days (oldest → today)
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(TODAY + 'T00:00:00');
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  // Count completed tasks per day (using createdAt as the date reference)
  const countsByDay = {};
  days.forEach(d => { countsByDay[d] = 0; });
  tasks.forEach(t => {
    if (t.completed && countsByDay[t.createdAt] !== undefined) {
      countsByDay[t.createdAt]++;
    }
  });

  const maxCount = Math.max(1, ...Object.values(countsByDay));
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  days.forEach(isoDate => {
    const count   = countsByDay[isoDate];
    const isToday = isoDate === TODAY;
    const pct     = (count / maxCount) * 100;
    const dayName = DAY_NAMES[new Date(isoDate + 'T00:00:00').getDay()];

    const col = document.createElement('div');
    col.className = `week-col${isToday ? ' week-col--today' : ''}`;

    const countEl = document.createElement('span');
    countEl.className   = 'week-count';
    countEl.textContent = count > 0 ? String(count) : '';

    const barWrap = document.createElement('div');
    barWrap.className = 'week-bar-wrap';

    const bar = document.createElement('div');
    bar.className  = 'week-bar';
    bar.style.height = `${Math.max(4, pct)}%`;
    bar.setAttribute('title', `${count} task${count !== 1 ? 's' : ''} completed`);

    barWrap.appendChild(bar);

    const dayLabel = document.createElement('span');
    dayLabel.className   = 'week-day';
    dayLabel.textContent = dayName;

    col.appendChild(countEl);
    col.appendChild(barWrap);
    col.appendChild(dayLabel);
    dom.weekChart.appendChild(col);
  });
}

/* ── 19f. Recently completed tasks (last 10) ── */
function _renderDashRecent() {
  const recent = tasks
    .filter(t => t.completed)
    .slice(0, 10);

  dom.dashRecent.innerHTML = '';
  dom.dashRecentEmpty.hidden = recent.length > 0;

  recent.forEach(t => {
    const li = document.createElement('li');
    li.className = 'dash-item dash-item--recent';
    const icon = { low: '🟢', medium: '🟡', high: '🔴' }[t.priority] || '✅';
    li.innerHTML = `
      <span class="dash-item__icon">${icon}</span>
      <div class="dash-item__body">
        <div class="dash-item__title">${_escHtml(t.text)}</div>
        <div class="dash-item__meta">${t.category ? _escHtml(t.category) + ' · ' : ''}${t.priority}</div>
      </div>`;
    dom.dashRecent.appendChild(li);
  });
}

/**
 * Minimal HTML-escape for text injected via innerHTML.
 * @param {string} str
 * @returns {string}
 */
function _escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ══════════════════════════════════════════════════════════════
   20. EVENT WIRING
══════════════════════════════════════════════════════════════ */

function wireEvents() {
  // Task form
  dom.taskForm.addEventListener('submit', handleAddTask);

  // Habit form
  dom.habitForm.addEventListener('submit', handleAddHabit);

  // Filter tabs
  dom.filterTabs.forEach(tab => tab.addEventListener('click', handleFilterClick));

  // WhatsApp form
  dom.waForm.addEventListener('submit', handleSaveWa);

  // WhatsApp quick send
  dom.waSend.addEventListener('click', handleQuickSend);

  // Toast close
  dom.toastClose.addEventListener('click', dismissToast);

  // Nav buttons
  dom.navBtns.forEach(btn => btn.addEventListener('click', () => navigateTo(btn.dataset.page)));

  // Edit modal — save, cancel, header close button
  dom.editForm.addEventListener('submit', handleEditSave);
  dom.editCancel.addEventListener('click', closeEditModal);
  dom.editModalClose.addEventListener('click', closeEditModal);

  // Click on modal backdrop (overlay) closes it
  dom.editModal.addEventListener('click', e => {
    if (e.target === dom.editModal) closeEditModal();
  });

  // Escape key closes modal or any open menu
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!dom.editModal.hidden) { closeEditModal();  return; }
      if (openMenuTaskId)        { closeTaskMenu();   return; }
      if (openHabitMenuId)       { _closeHabitMenu(); return; }
    }
  });

  // Click anywhere outside closes all open menus
  document.addEventListener('click', () => {
    if (openMenuTaskId)  closeTaskMenu();
    if (openHabitMenuId) _closeHabitMenu();
  });
}

/* ══════════════════════════════════════════════════════════════
   21. INITIALISATION
══════════════════════════════════════════════════════════════ */

function init() {
  loadFromStorage();
  wireEvents();
  renderDate();
  renderTasks();
  renderHabits();
  renderMetrics();
  renderWaSection();
  navigateTo('dashboard');   // start on dashboard, renders it too

  // Start alarm polling every 30 seconds
  pollAlarms();
  setInterval(pollAlarms, 30_000);
}

// Boot when DOM is ready
document.addEventListener('DOMContentLoaded', init);
