/* =====================================================================
 * TeamBoard — вся логика приложения (чистый JS, без сборки)
 * Зависимости: window.supabase (CDN), window.APP_CONFIG (js/config.js),
 *              marked + DOMPurify (CDN, подключаются в index.html)
 * ===================================================================== */
(function () {
  "use strict";

  /* ---------- Инициализация Supabase ---------- */
  const cfg = window.APP_CONFIG || {};
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_URL.includes("ВАШ-ПРОЕКТ")) {
    document.getElementById("auth-screen").classList.remove("hidden");
    setAuthMessage(
      "Не настроен Supabase. Откройте js/config.js и впишите SUPABASE_URL и SUPABASE_ANON_KEY из вашего проекта.",
      "error"
    );
    return;
  }
  const db = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  /* ---------- Состояние ---------- */
  let me = null;            // { id, full_name, role }
  let isAdmin = false;
  let profiles = [];        // все пользователи
  const profileById = (id) => profiles.find((p) => p.id === id);
  let currentTab = "tasks";
  let openTaskId = null;
  let selectedDocId = null;

  const STATUS_ORDER = ["todo", "in_progress", "review", "done", "closed"];
  const STATUS_META = {
    todo:        { label: "К выполнению", color: "#6b7a99" },
    in_progress: { label: "В работе",     color: "#0052cc" },
    review:      { label: "На проверке",  color: "#ff991f" },
    done:        { label: "Готово",       color: "#36b37e" },
    closed:      { label: "Закрыто",      color: "#42526e" },
  };

  /* ================= УТИЛИТЫ ================= */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function toast(text, type = "") {
    const el = document.createElement("div");
    el.className = "toast " + type;
    el.textContent = text;
    $("#toast-container").appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  function fmtDate(d) {
    if (!d) return "—";
    const dt = new Date(d);
    return dt.toLocaleDateString("ru-RU", { day: "numeric", month: "short", year: "2-digit" });
  }
  function fmtDateTime(d) {
    if (!d) return "";
    return new Date(d).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  function setAuthMessage(msg, cls = "") {
    const el = $("#auth-message");
    el.textContent = msg;
    el.className = "auth-message " + cls;
  }

  /* Markdown → безопасный HTML */
  function renderMarkdown(md) {
    if (!md) return "";
    let html = window.marked ? window.marked.parse(md, { breaks: true }) : esc(md);
    if (window.DOMPurify) html = window.DOMPurify.sanitize(html);
    return html;
  }

  /* Ссылки на статьи вида [[doc:ID]] или [[doc:ID|текст]] */
  function linkifyDocRefs(html) {
    return html.replace(/\[\[doc:(\d+)(?:\|([^\]]*))?\]\]/g, (_, id, text) => {
      const doc = docsCache.find((d) => d.id === Number(id));
      const label = text || (doc ? doc.title : "Статья #" + id);
      return `<a href="#" class="doc-ref-link" data-open-doc="${id}">${esc(label)}</a>`;
    });
  }

  /* ================= ЗАГРУЗКА ДАННЫХ ================= */
  let docsCache = [];

  async function loadProfiles() {
    const { data, error } = await db.from("profiles").select("*").order("full_name");
    if (error) throw error;
    profiles = data || [];
  }

  async function refreshAll() {
    try {
      await loadProfiles();
      await Promise.all([loadTasks(), loadDocs()]);
      if (isAdmin) renderAdmin();
    } catch (e) {
      console.error(e);
      toast("Ошибка загрузки: " + e.message, "error");
    }
  }

  /* ================= ЭКРАН ВХОДА / РЕГИСТРАЦИИ ================= */

  // Переключение вкладок входа/регистрации
  $$(".auth-tab").forEach((btn) =>
    btn.addEventListener("click", () => {
      $$(".auth-tab").forEach((b) => b.classList.toggle("active", b === btn));
      $("#login-form").classList.toggle("hidden", btn.dataset.mode !== "login");
      $("#register-form").classList.toggle("hidden", btn.dataset.mode !== "register");
      setAuthMessage("");
    })
  );

  $("#login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    setAuthMessage("Входим…");
    const { error } = await db.auth.signInWithPassword({
      email: $("#login-email").value.trim(),
      password: $("#login-password").value,
    });
    if (error) return setAuthMessage("Не удалось войти: " + error.message, "error");
    // успешный вход обработается в handleSession
  });

  $("#register-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fullName = $("#reg-name").value.trim();
    const email = $("#reg-email").value.trim();
    const password = $("#reg-password").value;
    const code = $("#reg-code").value.trim();

    setAuthMessage("Проверяю приглашение…");

    // 1. Проверка и «сжигание» пригласительного кода на стороне БД
    const { data: ok, error: rpcErr } = await db.rpc("consume_invite_code", {
      p_code: code,
      p_email: email,
    });
    if (rpcErr) return setAuthMessage("Ошибка сервера: " + rpcErr.message, "error");
    if (!ok) return setAuthMessage("Пригласительный код недействителен или уже использован.", "error");

    // 2. Регистрация
    setAuthMessage("Создаю аккаунт…");
    const { data, error } = await db.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } },
    });
    if (error) return setAuthMessage("Ошибка регистрации: " + error.message, "error");

    if (data.session) {
      // Email-подтверждение отключено — сразу внутри
      setAuthMessage("Готово! Добро пожаловать.", "ok");
    } else {
      setAuthMessage("Аккаунт создан. Проверьте почту и подтвердите регистрацию, затем войдите.", "ok");
      $$(".auth-tab")[0].click();
      $("#login-email").value = email;
    }
  });

  $("#logout-btn").addEventListener("click", async () => {
    await db.auth.signOut();
    location.reload();
  });

  /* ================= СЕССИЯ / РОЛИ ================= */

  async function handleSession(session) {
    if (!session) {
      $("#app").classList.add("hidden");
      $("#auth-screen").classList.remove("hidden");
      return;
    }
    const uid = session.user.id;
    myEmail = session.user.email || "";
    // профиль мог ещё не создаться триггером — подождём пару раз
    for (let i = 0; i < 5; i++) {
      await loadProfiles().catch(() => {});
      me = profileById(uid);
      if (me) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    if (!me) {
      setAuthMessage("Профиль не найден. Напиши админу — возможно, регистрация не дошла.", "error");
      await db.auth.signOut();
      return;
    }
    isAdmin = me.role === "admin";

    $("#auth-screen").classList.add("hidden");
    $("#app").classList.remove("hidden");
    $("#current-user-label").textContent = `${me.full_name || me.id.slice(0, 6)}${isAdmin ? " · капитан" : ""}`;

    applyRoleUI();
    await refreshAll();
    subscribeToRealtime();
  }

  function applyRoleUI() {
    // скрыть/показать всё, что только для админа
    $$(".admin-only").forEach((el) => el.classList.toggle("hidden", !isAdmin));
    $$(".admin-only-inline").forEach((el) => (el.style.display = isAdmin ? "" : "none"));
    $("#task-create-section").classList.toggle("hidden", !isAdmin);
    $("#filter-assignee").parentElement?.classList.toggle("hidden", !isAdmin);
    if (!isAdmin) $("#tab-admin").classList.add("hidden");
  }

  db.auth.onAuthStateChange((_event, session) => handleSession(session));
  db.auth.getSession().then(({ data }) => handleSession(data.session));

  /* ================= ВКЛАДКИ ================= */
  $$(".tab-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      currentTab = btn.dataset.tab;
      $$(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
      ["tasks", "docs", "admin"].forEach((t) =>
        $("#tab-" + t).classList.toggle("hidden", t !== currentTab)
      );
    })
  );

  /* ================= ЗАДАЧИ: ЗАГРУЗКА И РЕНДЕР ================= */
  let tasks = [];

  async function loadTasks() {
    const { data, error } = await db
      .from("tasks")
      .select("*")
      .order("updated_at", { ascending: false });
    if (error) throw error;
    tasks = data || [];
    renderBoard();
    fillAssigneeSelects();
  }

  function visibleTasks() {
    const fs = $("#filter-status").value;
    const fa = $("#filter-assignee").value;
    return tasks.filter((t) => {
      // Рабочий видит задачи, назначенные на него, и «общие» без исполнителя.
      // (В Supabase RLS открыт select на все задачи — при желании фильтр
      //  «только свои» можно перенести и в политику БД, см. 02_rls.sql.)
      if (!isAdmin && t.assignee_id !== me.id && t.assignee_id !== null) return false;
      if (fs && t.status !== fs) return false;
      if (isAdmin && fa && t.assignee_id !== fa) return false;
      return true;
    });
  }

  function dueClass(t) {
    if (!t.due_date || t.status === "done" || t.status === "closed") return "";
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const due = new Date(t.due_date + "T00:00:00");
    if (due < today) return "overdue";
    const diff = (due - today) / 86400000;
    return diff <= 2 ? "soon" : "";
  }

  function renderBoard() {
    $("#board-title").textContent = isAdmin ? "Все задачи команды" : "Мои задачи";
    const board = $("#tasks-board");
    board.innerHTML = "";
    const list = visibleTasks();

    STATUS_ORDER.forEach((st) => {
      const items = list.filter((t) => t.status === st);
      const col = document.createElement("div");
      col.className = "kanban-col";
      col.style.setProperty("--col-color", STATUS_META[st].color);
      col.innerHTML = `
        <div class="kanban-col-head">
          <span>${STATUS_META[st].label}</span>
          <span class="kanban-count">${items.length}</span>
        </div>`;
      if (!items.length) {
        col.insertAdjacentHTML("beforeend", `<div class="empty-col">Пусто</div>`);
      }
      items.forEach((t) => {
        const assignee = profileById(t.assignee_id);
        const card = document.createElement("div");
        card.className = "task-card";
        card.style.setProperty("--status-color", STATUS_META[t.status].color);
        card.innerHTML = `
          <div class="t-key">TASK-${t.id}</div>
          <div class="t-title">${esc(t.title)}</div>
          <div class="t-meta">
            <span>👤 ${esc(assignee?.full_name || "не назначен")}</span>
            <span class="t-due ${dueClass(t)}">${fmtDate(t.due_date)}</span>
          </div>`;
        card.addEventListener("click", () => openTask(t.id));
        col.appendChild(card);
      });
      board.appendChild(col);
    });
  }

  $("#filter-status").addEventListener("change", renderBoard);
  $("#filter-assignee").addEventListener("change", renderBoard);

  function fillAssigneeSelects() {
    const opts = profiles
      .slice()
      .sort((a, b) => (a.full_name > b.full_name ? 1 : -1))
      .map((p) => `<option value="${p.id}">${esc(p.full_name || p.id.slice(0, 8))}</option>`)
      .join("");
    $("#tc-assignee").innerHTML = `<option value="">— выберите —</option>${opts}`;
    $("#filter-assignee").innerHTML = `<option value="">Все исполнители</option>${opts}`;
  }

  /* Создание задачи (админ) */
  $("#task-create-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const payload = {
      title: $("#tc-title").value.trim(),
      description: $("#tc-desc").value,
      assignee_id: $("#tc-assignee").value || null,
      creator_id: me.id,
      status: "todo",
      due_date: $("#tc-due").value || null,
    };
    if (!payload.title) return;
    const { error } = await db.from("tasks").insert(payload);
    if (error) return toast("Не удалось создать задачу: " + error.message, "error");
    toast("Задача создана", "ok");
    ev.target.reset();
    await loadTasks();
  });

  /* ================= КАРТОЧКА ЗАДАЧИ (модалка) ================= */
  let taskComments = [];

  async function openTask(id) {
    openTaskId = id;
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    await loadComments(id);

    $("#tm-key").textContent = "TASK-" + t.id;
    $("#tm-title").textContent = t.title;
    $("#tm-status").textContent = STATUS_META[t.status].label;
    $("#tm-assignee").textContent = profileById(t.assignee_id)?.full_name || "не назначен";
    $("#tm-due").textContent = fmtDate(t.due_date);
    $("#tm-creator").textContent = profileById(t.creator_id)?.full_name || "—";
    $("#tm-desc").innerHTML = linkifyDocRefs(renderMarkdown(t.description)) || "<i>Без описания</i>";

    // Права на смену статуса
    const canMove = isAdmin || t.assignee_id === me.id;
    $$("#task-modal .status-btn").forEach((btn) => {
      const target = btn.dataset.status;
      let allowed = canMove;
      if ((target === "done" || target === "closed") && !isAdmin) allowed = false;
      btn.style.display = allowed ? "" : "none";
    });
    $("#tm-status-hint").style.display = isAdmin ? "none" : "";

    renderComments();
    $("#task-modal").classList.remove("hidden");

    // ссылки на статьи внутри описания
    $("#tm-desc").querySelectorAll("[data-open-doc]").forEach((a) =>
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        closeModal("#task-modal");
        switchTab("docs");
        selectDoc(Number(a.dataset.openDoc));
      })
    );
  }

  function switchTab(tab) {
    $(`.tab-btn[data-tab="${tab}"]`).click();
  }

  // Смена статуса
  $$("#task-modal .status-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!openTaskId) return;
      const { error } = await db
        .from("tasks")
        .update({ status: btn.dataset.status })
        .eq("id", openTaskId);
      if (error) return toast("Сервер отклонил: " + error.message, "error");
      await loadTasks();
      closeModal("#task-modal");
    })
  );

  async function loadComments(taskId) {
    const { data, error } = await db
      .from("task_comments")
      .select("*")
      .eq("task_id", taskId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    taskComments = data || [];
  }

  function renderComments() {
    const box = $("#tm-comments");
    if (!taskComments.length) {
      box.innerHTML = `<p class="empty-hint">Комментариев пока нет.</p>`;
      return;
    }
    box.innerHTML = taskComments
      .map((c) => {
        const a = profileById(c.author_id);
        return `
        <div class="comment">
          <div class="comment-head"><b>${esc(a?.full_name || "кто-то")}</b> · ${fmtDateTime(c.created_at)}</div>
          <div class="comment-body">${esc(c.body)}</div>
        </div>`;
      })
      .join("");
  }

  $("#comment-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = $("#comment-text").value.trim();
    if (!body || !openTaskId) return;
    const { error } = await db
      .from("task_comments")
      .insert({ task_id: openTaskId, author_id: me.id, body });
    if (error) return toast("Не удалось отправить: " + error.message, "error");
    $("#comment-text").value = "";
    await loadComments(openTaskId);
    renderComments();
  });

  /* ================= ДОКУМЕНТАЦИЯ ================= */
  async function loadDocs() {
    const { data, error } = await db
      .from("docs")
      .select("id, title, content, updated_at")
      .order("title");
    if (error) throw error;
    docsCache = data || [];
    renderDocsList();
    if (selectedDocId) selectDoc(selectedDocId, true);
  }

  function renderDocsList() {
    const q = $("#docs-search").value.trim().toLowerCase();
    const ul = $("#docs-list");
    const items = docsCache.filter(
      (d) => !q || d.title.toLowerCase().includes(q) || d.content.toLowerCase().includes(q)
    );
    ul.innerHTML = items
      .map(
        (d) =>
          `<li data-id="${d.id}" class="${d.id === selectedDocId ? "active" : ""}">${esc(d.title)} <span class="hint">#${d.id}</span></li>`
      )
      .join("") || `<p class="empty-hint">Ничего не найдено.</p>`;
    ul.querySelectorAll("li[data-id]").forEach((li) =>
      li.addEventListener("click", () => selectDoc(Number(li.dataset.id)))
    );
  }

  $("#docs-search").addEventListener("input", renderDocsList);

  function selectDoc(id, keep) {
    const doc = docsCache.find((d) => d.id === id);
    if (!doc) return;
    selectedDocId = id;
    renderDocsList();
    const viewer = $("#doc-viewer");
    viewer.innerHTML = `
      <h2>${esc(doc.title)}</h2>
      <div class="doc-updated">Обновлено: ${fmtDateTime(doc.updated_at)} · ID статьи: ${doc.id}
        ${isAdmin ? '<button class="btn btn-sm btn-ghost" id="doc-edit-btn">✏️ Редактировать</button>' : ""}
      </div>
      <div class="markdown-body">${renderMarkdown(doc.content)}</div>`;
    if (isAdmin) $("#doc-edit-btn").addEventListener("click", () => openDocEditor(doc));
  }

  /* --- редактор статей (админ) --- */
  $("#doc-create-btn").addEventListener("click", () => openDocEditor(null));

  function openDocEditor(doc) {
    $("#de-heading").textContent = doc ? "Редактирование статьи" : "Новая статья";
    $("#de-id").value = doc ? doc.id : "";
    $("#de-title").value = doc ? doc.title : "";
    $("#de-content").value = doc ? doc.content : "";
    $("#de-delete").classList.toggle("hidden", !doc);
    $("#de-copy-link").classList.toggle("hidden", !doc);
    $("#doc-editor-modal").classList.remove("hidden");
  }

  $("#doc-edit-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const id = $("#de-id").value;
    const payload = { title: $("#de-title").value.trim(), content: $("#de-content").value };
    let error;
    if (id) {
      ({ error } = await db.from("docs").update(payload).eq("id", Number(id)));
    } else {
      ({ error } = await db.from("docs").insert({ ...payload, author_id: me.id }));
    }
    if (error) return toast("Сохранить не удалось: " + error.message, "error");
    toast("Статья сохранена", "ok");
    closeModal("#doc-editor-modal");
    await loadDocs();
  });

  $("#de-delete").addEventListener("click", async () => {
    const id = Number($("#de-id").value);
    if (!id || !confirm("Удалить статью?")) return;
    const { error } = await db.from("docs").delete().eq("id", id);
    if (error) return toast(error.message, "error");
    if (selectedDocId === id) {
      selectedDocId = null;
      $("#doc-viewer").innerHTML = `<p class="empty-hint">Выберите статью слева.</p>`;
    }
    closeModal("#doc-editor-modal");
    await loadDocs();
  });

  $("#de-copy-link").addEventListener("click", () => {
    const url = location.origin + location.pathname + "#doc-" + $("#de-id").value;
    navigator.clipboard?.writeText(url).then(() => toast("Ссылка скопирована — можно вставить в описание задачи", "ok"));
  });

  /* ================= АДМИН ================= */
  function renderAdmin() {
    // команда
    const tb = $("#users-table tbody");
    tb.innerHTML = profiles
      .map((p) => {
        const email = p.id === me.id ? myEmail : "";
        const self = p.id === me.id;
        return `<tr>
          <td>${esc(p.full_name || "(без имени)")}${self ? " <span class='hint'>(вы)</span>" : ""}</td>
          <td class="hint">${esc(email)}</td>
          <td>${p.role === "admin" ? "👑 admin" : "worker"}</td>
          <td>${
            self || p.role === "admin"
              ? ""
              : `<button class="btn btn-sm btn-ghost" data-promote="${p.id}">→ admin</button>`
          }</td>
        </tr>`;
      })
      .join("");
    tb.querySelectorAll("[data-promote]").forEach((b) =>
      b.addEventListener("click", async () => {
        if (!confirm("Назначить этого человека админом?")) return;
        const { error } = await db.from("profiles").update({ role: "admin" }).eq("id", b.dataset.promote);
        if (error) return toast(error.message, "error");
        await loadProfiles();
        renderAdmin();
      })
    );

    // приглашения
    renderInvites();
  }

  let invites = [];
  async function renderInvites() {
    const { data } = await db.from("invite_codes").select("*").order("created_at", { ascending: false });
    invites = data || [];
    const tb = $("#invites-table tbody");
    tb.innerHTML =
      invites
        .map((i) => {
          const used = !!i.used_at;
          const who = used && i.used_by ? profileById(i.used_by)?.full_name || i.used_by.slice(0, 6) : "";
          return `<tr>
            <td><span class="invite-code ${used ? "used-code" : ""}">${esc(i.code)}</span></td>
            <td>${used ? "использован" + (who ? " → " + esc(who) : "") : "активен"}</td>
            <td>${used ? "" : `<button class="btn btn-sm btn-ghost" data-copy="${esc(i.code)}">копировать</button>`}</td>
          </tr>`;
        })
        .join("") || `<tr><td colspan="3" class="hint">Пока нет кодов.</td></tr>`;
    tb.querySelectorAll("[data-copy]").forEach((b) =>
      b.addEventListener("click", () => {
        navigator.clipboard?.writeText(b.dataset.copy);
        toast("Код скопирован — отправьте новичку", "ok");
      })
    );
  }

  $("#invite-generate-btn").addEventListener("click", async () => {
    const code = crypto.randomUUID().slice(0, 8);
    const { error } = await db.from("invite_codes").insert({ code, created_by: me.id });
    if (error) return toast(error.message, "error");
    const span = $("#invite-latest");
    span.innerHTML = `Новый код: <span class="invite-code">${code}</span> — передайте его человеку`;
    span.classList.remove("hidden");
    await renderInvites();
  });

  /* Email показываем только для собственного аккаунта (берём из сессии). */
  let myEmail = "";

  /* ================= REALTIME (живое обновление) ================= */
  function subscribeToRealtime() {
    db.channel("teamboard-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, () => loadTasks())
      .on("postgres_changes", { event: "*", schema: "public", table: "docs" }, () => loadDocs())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "profiles" }, async () => {
        await loadProfiles();
        renderBoard();
        fillAssigneeSelects();
        if (isAdmin) renderAdmin();
      })
      .subscribe();
  }

  /* ================= МОДАЛКИ: общее ================= */
  function closeModal(sel) {
    const el = $(sel);
    if (el) el.classList.add("hidden");
    if (sel === "#task-modal") openTaskId = null;
  }
  $$("[data-close-modal]").forEach((b) =>
    b.addEventListener("click", () => {
      const ov = b.closest(".modal-overlay");
      if (ov) closeModal("#" + ov.id);
    })
  );
  $$(".modal-overlay").forEach((ov) =>
    ov.addEventListener("click", (ev) => {
      if (ev.target === ov) closeModal("#" + ov.id);
    })
  );
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") $$(".modal-overlay:not(.hidden)").forEach((m) => closeModal("#" + m.id));
  });

  /* ================= ГЛУБОКАЯ ССЫЛКА #doc-ID ================= */
  function handleHash() {
    const m = location.hash.match(/^#doc-(\d+)$/);
    if (m) {
      switchTab("docs");
      selectDoc(Number(m[1]));
    }
  }
  window.addEventListener("hashchange", handleHash);
  document.addEventListener("DOMContentLoaded", handleHash);
})();
