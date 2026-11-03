"use strict";

const API_BASE = String(window.ESTATE_CONFIG?.apiBase || "").replace(/\/+$/, "");
const grid = document.getElementById("property-grid");
const propertySelect = document.getElementById("property-select");
const form = document.getElementById("lead-form");
const statusElement = document.getElementById("form-status");
const responseOptions = document.getElementById("response-options");

document.getElementById("year").textContent = String(new Date().getFullYear());

function makeElement(tag, className = "", text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatPrice(price, currency) {
  const amount = Number(price);
  if (!Number.isFinite(amount) || typeof currency !== "string") {
    return "Price on request";
  }

  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0
    }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString()}`;
  }
}

function isValidProperty(property) {
  return Boolean(
    property
    && typeof property === "object"
    && typeof property.code === "string"
    && /^EST-[A-Z0-9]{6}$/.test(property.code)
    && typeof property.title === "string"
    && typeof property.location === "string"
    && typeof property.image === "string"
    && property.image.startsWith("https://")
  );
}

function createPropertyCard(property) {
  const card = makeElement("article", "property-card");
  const imageWrap = makeElement("div", "property-image-wrap");
  const image = makeElement("img", "property-image");

  image.src = property.image;
  image.alt = property.image_alt || property.title;
  image.loading = "lazy";
  image.decoding = "async";
  image.addEventListener("error", () => {
    image.alt = "Property image unavailable";
    image.removeAttribute("src");
  }, { once: true });

  imageWrap.append(image, makeElement("span", "property-code", property.code));

  if (property.demo === true) {
    imageWrap.append(makeElement("span", "demo-badge", "Illustrative example"));
  }

  const content = makeElement("div", "property-content");
  content.append(
    makeElement("p", "property-location", property.location),
    makeElement("h3", "property-title", property.title),
    makeElement("p", "property-description", property.description || "")
  );

  const specs = makeElement("div", "property-specs");
  if (property.bedrooms != null) {
    specs.append(makeElement("span", "", `${property.bedrooms} bedrooms`));
  }
  if (property.bathrooms != null) {
    specs.append(makeElement("span", "", `${property.bathrooms} bathrooms`));
  }
  if (property.area_sqm != null) {
    specs.append(makeElement("span", "", `${property.area_sqm} m²`));
  }

  const bottom = makeElement("div", "property-bottom");
  const price = makeElement(
    "div",
    "property-price",
    formatPrice(property.price, property.currency)
  );
  price.append(makeElement("small", "", "Indicative asking price"));

  const button = makeElement("button", "button button-dark", "Request details");
  button.type = "button";
  button.setAttribute(
    "aria-label",
    `Request details for ${property.title}, reference ${property.code}`
  );
  button.addEventListener("click", () => {
    propertySelect.value = property.code;
    document.getElementById("inquiry").scrollIntoView({ behavior: "smooth" });
    form.elements.name.focus({ preventScroll: true });
  });

  bottom.append(price, button);
  content.append(specs, bottom);
  card.append(imageWrap, content);
  return card;
}

async function loadProperties() {
  try {
    const response = await fetch("properties.json", { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(`Property feed returned HTTP ${response.status}.`);
    }

    const properties = await response.json();
    if (!Array.isArray(properties)) {
      throw new Error("Property feed must be a JSON array.");
    }

    const seenCodes = new Set();
    const available = properties.filter((property) => {
      if (!isValidProperty(property) || seenCodes.has(property.code)) return false;
      seenCodes.add(property.code);
      return true;
    });

    grid.replaceChildren();
    propertySelect.replaceChildren(new Option("Not sure yet", ""));

    for (const property of available) {
      grid.append(createPropertyCard(property));
      propertySelect.add(new Option(`${property.code} — ${property.title}`, property.code));
    }

    if (available.length === 0) {
      grid.append(makeElement("p", "loading-message", "The collection is being updated."));
    }
  } catch (error) {
    console.error("Unable to load properties:", error);
    grid.replaceChildren(
      makeElement("p", "loading-message", "The collection could not be loaded. Please try again later.")
    );
  }
}

function validateFollowUpLinks(data) {
  if (!data || typeof data.call_url !== "string" || typeof data.telegram_url !== "string") {
    return null;
  }

  let callUrl;
  let telegramUrl;

  try {
    callUrl = new URL(data.call_url);
    telegramUrl = new URL(data.telegram_url);
  } catch {
    return null;
  }

  const validCall =
    callUrl.protocol === "tel:"
    && /^\+?[0-9][0-9(). -]*$/.test(callUrl.pathname);

  const validTelegram =
    telegramUrl.protocol === "https:"
    && (telegramUrl.hostname === "t.me" || telegramUrl.hostname === "www.t.me")
    && !telegramUrl.username
    && !telegramUrl.password;

  if (!validCall || !validTelegram) return null;

  return {
    call: callUrl.href,
    telegram: telegramUrl.href
  };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  statusElement.className = "form-status";
  statusElement.textContent = "";
  responseOptions.hidden = true;

  if (!API_BASE) {
    statusElement.className = "form-status error";
    statusElement.textContent = "Inquiry service is not configured. Please try again later.";
    return;
  }

  let apiOrigin;
  try {
    apiOrigin = new URL(API_BASE);
  } catch {
    statusElement.className = "form-status error";
    statusElement.textContent = "Inquiry service is not configured correctly.";
    return;
  }

  if (apiOrigin.protocol !== "https:" && apiOrigin.hostname !== "localhost") {
    statusElement.className = "form-status error";
    statusElement.textContent = "The inquiry service must use a secure HTTPS connection.";
    return;
  }

  const submitButton = form.querySelector('button[type="submit"]');
  const originalButtonMarkup = submitButton.innerHTML;
  submitButton.disabled = true;
  submitButton.textContent = "Sending…";

  const values = new FormData(form);
  const payload = {
    name: String(values.get("name") || "").trim(),
    email: String(values.get("email") || "").trim(),
    phone: String(values.get("phone") || "").trim(),
    property_code: String(values.get("property_code") || ""),
    message: String(values.get("message") || "").trim(),
    consent: values.get("consent") === "on"
  };

  try {
    const response = await fetch(`${API_BASE}/api/leads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        typeof result.detail === "string"
          ? result.detail
          : "Your inquiry could not be submitted. Please try again."
      );
    }

    statusElement.className = "form-status success";
    statusElement.textContent = "Thank you. Your inquiry has been received.";

    const links = validateFollowUpLinks(result);
    if (links) {
      document.getElementById("call-link").href = links.call;
      document.getElementById("telegram-link").href = links.telegram;
      responseOptions.hidden = false;
    } else {
      statusElement.textContent =
        "Your inquiry was received. Follow-up links are temporarily unavailable.";
    }

    form.reset();
  } catch (error) {
    statusElement.className = "form-status error";
    statusElement.textContent =
      error instanceof Error ? error.message : "Something went wrong. Please try again.";
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = originalButtonMarkup;
  }
});

loadProperties();
