(() => {
  "use strict";

  // Бекенд-эндпоинт (приёмник + ответчик находятся за одним и тем же URL).
  const API_URL = "/api/chat.php";
  const COOKIE_NAME = "tea_cid";
  const COOKIE_DAYS = 30;

  const chatLog = document.getElementById("chatLog");
  const chatForm = document.getElementById("chatForm");
  const messageInput = document.getElementById("messageInput");
  const sendBtn = document.getElementById("sendBtn");
  const newChatBtn = document.getElementById("newChatBtn");
  const typingIndicator = document.getElementById("typingIndicator");

  // ---------- Высота экрана на мобильных (клавиатура, панели браузера) ----------
  // 100dvh в CSS в теории уже должен реагировать на появление клавиатуры, но в
  // части версий мобильного Safari/встроенных браузеров (например, внутри других
  // приложений) это работает не всегда надёжно. Подстраховываемся через
  // visualViewport — он точно знает реальную видимую высоту — и держим её
  // в CSS-переменной --app-height.
  function setAppHeight() {
    const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    document.documentElement.style.setProperty("--app-height", h + "px");
  }
  setAppHeight();
  window.addEventListener("resize", setAppHeight);
  window.addEventListener("orientationchange", setAppHeight);
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", setAppHeight);
    window.visualViewport.addEventListener("scroll", setAppHeight);
  }

  // ---------- Работа с cookie (история диалога привязана к conversation_id в cookie) ----------

  function getCookie(name) {
    const match = document.cookie.match(
      new RegExp("(?:^|; )" + name.replace(/([.$?*|{}()[\]\\/+^])/g, "\\$1") + "=([^;]*)")
    );
    return match ? decodeURIComponent(match[1]) : null;
  }

  function setCookie(name, value, days) {
    const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
  }

  function deleteCookie(name) {
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }

  // Видимая история чата на экране кэшируется в sessionStorage, чтобы не потерять её
  // при обновлении страницы (сама переписка хранится на сервере по conversation_id).
  const RENDER_CACHE_KEY = "tea_chat_render_cache";
  // Версия формата кэша: увеличивать при любой правке приветствия/формата записи,
  // иначе у посетителя, открывавшего сайт раньше в этой вкладке, sessionStorage
  // так и будет молча подсовывать старый текст/старую вёрстку вместо нового кода.
  const RENDER_CACHE_VERSION = "2";
  const RENDER_CACHE_VERSION_KEY = "tea_chat_render_cache_v";

  function loadRenderCache() {
    try {
      if (sessionStorage.getItem(RENDER_CACHE_VERSION_KEY) !== RENDER_CACHE_VERSION) {
        return [];
      }
      const raw = sessionStorage.getItem(RENDER_CACHE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveRenderCache(items) {
    try {
      sessionStorage.setItem(RENDER_CACHE_KEY, JSON.stringify(items));
      sessionStorage.setItem(RENDER_CACHE_VERSION_KEY, RENDER_CACHE_VERSION);
    } catch (e) {
      /* игнорируем — это не критично для работы чата */
    }
  }

  // ---------- Рендер сообщений ----------

  function appendMessage(entry, persist = true) {
    const el = document.createElement("div");
    el.className = `msg msg--${entry.role}`;

    const textNode = document.createElement("div");
    textNode.textContent = entry.text;
    el.appendChild(textNode);

    if (entry.followUp) {
      const fu = document.createElement("div");
      fu.className = "msg__followup";
      fu.textContent = entry.followUp;
      el.appendChild(fu);
    }

    if (entry.productIds && entry.productIds.length > 0) {
      const p = document.createElement("div");
      p.className = "msg__products";
      p.textContent = "Рекомендованные товары: ID " + entry.productIds.join(", ");
      el.appendChild(p);
    }

    chatLog.appendChild(el);
    chatLog.scrollTop = chatLog.scrollHeight;

    if (persist) {
      const cache = loadRenderCache();
      cache.push(entry);
      saveRenderCache(cache);
    }
  }

  const WELCOME_TEXT = "Привет, какой чай тебя интересует?";

  // Приветствие "печатается" по буквам — демо-эффект, чтобы сразу было видно,
  // что это живой диалог, а не статичная заглушка. Показывается только на
  // первом заходе (пока в истории чата ничего нет); при восстановлении из
  // кэша (после обновления страницы) приветствие подставляется сразу целиком.
  function typeWriterWelcome(text, speed = 32) {
    const el = document.createElement("div");
    el.className = "msg msg--system";

    const textNode = document.createElement("span");
    el.appendChild(textNode);

    const cursor = document.createElement("span");
    cursor.className = "msg__cursor";
    el.appendChild(cursor);

    chatLog.appendChild(el);

    const cache = loadRenderCache();
    cache.push({ role: "system", text });
    saveRenderCache(cache);

    let i = 0;
    function step() {
      textNode.textContent = text.slice(0, i);
      chatLog.scrollTop = chatLog.scrollHeight;
      if (i < text.length) {
        i++;
        setTimeout(step, speed);
      } else {
        cursor.remove();
      }
    }
    step();
  }

  function renderWelcome(animated) {
    if (animated) {
      typeWriterWelcome(WELCOME_TEXT);
    } else {
      appendMessage({ role: "system", text: WELCOME_TEXT }, false);
    }
  }

  function restoreChat() {
    const cache = loadRenderCache();
    if (cache.length === 0) {
      renderWelcome(true);
      return;
    }
    cache.forEach((entry) => appendMessage(entry, false));
  }

  // ---------- Отправка сообщения ----------

  function setLoading(isLoading) {
    sendBtn.disabled = isLoading;
    messageInput.disabled = isLoading;
    typingIndicator.hidden = !isLoading;
    if (isLoading) {
      chatLog.scrollTop = chatLog.scrollHeight;
    }
  }

  async function sendMessage(text) {
    const conversationId = getCookie(COOKIE_NAME);

    let response;
    try {
      response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: conversationId,
          message: text,
        }),
      });
    } catch (networkError) {
      appendMessage({
        role: "error",
        text: "Не удалось связаться с сервером. Проверьте подключение к интернету и попробуйте ещё раз.",
      });
      return;
    }

    let data;
    try {
      data = await response.json();
    } catch (parseError) {
      appendMessage({
        role: "error",
        text: "Сервер вернул некорректный ответ. Попробуйте повторить запрос немного позже.",
      });
      return;
    }

    if (!response.ok || !data.success) {
      appendMessage({
        role: "error",
        text: data.error || "Сейчас консультант временно недоступен. Попробуйте, пожалуйста, чуть позже.",
      });
      return;
    }

    if (data.conversation_id) {
      setCookie(COOKIE_NAME, data.conversation_id, COOKIE_DAYS);
    }

    appendMessage({
      role: "bot",
      text: data.answer || "",
      followUp: data.follow_up_question || null,
      productIds: Array.isArray(data.product_ids) ? data.product_ids : [],
    });
  }

  chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = messageInput.value.trim();
    if (!text) return;

    appendMessage({ role: "user", text });
    messageInput.value = "";
    autoResizeInput();

    setLoading(true);
    try {
      await sendMessage(text);
    } finally {
      setLoading(false);
      messageInput.focus();
    }
  });

  messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      chatForm.requestSubmit();
    }
  });

  function autoResizeInput() {
    messageInput.style.height = "auto";
    messageInput.style.height = Math.min(messageInput.scrollHeight, 120) + "px";
  }

  messageInput.addEventListener("input", autoResizeInput);
  autoResizeInput();

  // При фокусе на поле ввода на телефоне открывается клавиатура — даём браузеру
  // время пересчитать видимую область и подскролливаем и лог, и само поле,
  // чтобы форма не пряталась за клавиатурой.
  messageInput.addEventListener("focus", () => {
    setTimeout(() => {
      setAppHeight();
      chatLog.scrollTop = chatLog.scrollHeight;
      messageInput.scrollIntoView({ block: "end", behavior: "smooth" });
    }, 300);
  });

  newChatBtn.addEventListener("click", () => {
    deleteCookie(COOKIE_NAME);
    saveRenderCache([]);
    chatLog.innerHTML = "";
    renderWelcome(true);
    messageInput.value = "";
    autoResizeInput();
    messageInput.focus();
  });

  restoreChat();
})();
