/* Popup: manage the saved passenger list stored in chrome.storage.local
 * under the key "iffPassengers". */
(function () {
  "use strict";

  const KEY = "iffPassengers";
  let passengers = [];

  const $ = (id) => document.getElementById(id);

  function load() {
    chrome.storage.local.get([KEY], (data) => {
      passengers = Array.isArray(data[KEY]) ? data[KEY] : [];
      render();
    });
  }

  function save(cb) {
    chrome.storage.local.set({ [KEY]: passengers }, cb || function () {});
  }

  function render() {
    const list = $("list");
    list.innerHTML = "";
    if (!passengers.length) {
      const d = document.createElement("div");
      d.className = "empty";
      d.textContent = "No passengers saved yet. Add one below.";
      list.appendChild(d);
      return;
    }
    passengers.forEach((p, i) => {
      const row = document.createElement("div");
      row.className = "pass";
      const meta = [p.age && p.age + " yrs", p.gender, p.berth || "No berth pref"]
        .filter(Boolean)
        .join(" · ");
      row.innerHTML = `
        <div class="info">
          <div class="nm"></div>
          <div class="meta"></div>
        </div>
        <div class="ops">
          <button class="edit" data-i="${i}">Edit</button>
          <button class="del" data-i="${i}">Delete</button>
        </div>`;
      row.querySelector(".nm").textContent = p.name;
      row.querySelector(".meta").textContent = meta;
      list.appendChild(row);
    });

    list.querySelectorAll(".del").forEach((b) =>
      b.addEventListener("click", () => {
        passengers.splice(parseInt(b.dataset.i, 10), 1);
        save(load);
      })
    );
    list.querySelectorAll(".edit").forEach((b) =>
      b.addEventListener("click", () => startEdit(parseInt(b.dataset.i, 10)))
    );
  }

  function readForm() {
    return {
      name: $("f-name").value.trim(),
      age: $("f-age").value.trim(),
      gender: $("f-gender").value,
      berth: $("f-berth").value,
      nationality: $("f-nat").value.trim() || "India",
    };
  }

  function clearForm() {
    $("edit-index").value = "-1";
    $("f-name").value = "";
    $("f-age").value = "";
    $("f-gender").value = "";
    $("f-berth").value = "";
    $("f-nat").value = "India";
    $("form-title").textContent = "Add passenger";
    $("save").textContent = "Save passenger";
    $("cancel").style.display = "none";
    $("msg").textContent = "";
  }

  function startEdit(i) {
    const p = passengers[i];
    $("edit-index").value = String(i);
    $("f-name").value = p.name || "";
    $("f-age").value = p.age || "";
    $("f-gender").value = p.gender || "";
    $("f-berth").value = p.berth || "";
    $("f-nat").value = p.nationality || "India";
    $("form-title").textContent = "Edit passenger";
    $("save").textContent = "Update passenger";
    $("cancel").style.display = "block";
    $("f-name").focus();
  }

  function onSave() {
    const p = readForm();
    if (!p.name) {
      $("msg").textContent = "Name is required.";
      return;
    }
    if (!p.age) {
      $("msg").textContent = "Age is required.";
      return;
    }
    if (!p.gender) {
      $("msg").textContent = "Gender is required.";
      return;
    }
    const idx = parseInt($("edit-index").value, 10);
    if (idx >= 0) passengers[idx] = p;
    else passengers.push(p);
    save(() => {
      clearForm();
      load();
      $("msg").textContent = "Saved.";
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("save").addEventListener("click", onSave);
    $("cancel").addEventListener("click", clearForm);
    load();
  });
})();
