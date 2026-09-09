import { MAX_MODEL_DESCRIPTION_LENGTH } from "./modelDescriptions.js";

// Serialized as source so retained cards do not depend on compiler-generated helpers.
export const MODEL_DESCRIPTION_EDITOR_SCRIPT = String.raw`function createModelDescriptionEditor(root, options) {
      const edits = new Map(), expanded = new Set();
      const limit = ${MAX_MODEL_DESCRIPTION_LENGTH};
      let snapshot = null, blocked = false;
      const copy = (key) => options.text(key);
      const saved = (id) => {
        const overrides = snapshot && snapshot.settings.modelDescriptionOverrides || {};
        return Object.prototype.hasOwnProperty.call(overrides, id) ? overrides[id] : null;
      };
      const models = () => new Map(((snapshot && snapshot.catalog.models) || []).filter((model) => !model.hidden).map((model) => [model.id, model]));
      function node(tag, text, className) {
        const element = document.createElement(tag);
        if (text !== undefined) element.textContent = text;
        if (className) element.className = className;
        return element;
      }
      function button(text, action, handler) {
        const element = node("button", text);
        element.type = "button";
        element.dataset.descriptionAction = action;
        element.disabled = blocked;
        element.addEventListener("click", handler);
        return element;
      }
      function beginEdit(id, official) {
        const override = saved(id), initialText = override === null ? official || "" : override;
        edits.set(id, { text: initialText, initialText, initialOverride: override, expectedOverride: override });
        render();
        const row = [...root.children].find((element) => element.dataset.model === id);
        if (row) row.querySelector("textarea").focus();
      }
      async function persist(id, restore) {
        if (!snapshot || blocked) return;
        const edit = edits.get(id), current = saved(id);
        const official = models().get(id)?.description || "";
        let nextValue = null;
        if (!restore && edit) {
          const trimmed = edit.text.trim();
          if (trimmed.length > limit) { edit.error = "tooLong"; render(); return; }
          nextValue = trimmed === edit.initialText.trim() ? edit.initialOverride
            : !trimmed || trimmed === official.trim() ? null : trimmed;
          if (current !== edit.expectedOverride) {
            edit.expectedOverride = current;
            edit.error = "conflict";
            render();
            return;
          }
        }
        if (nextValue === current) { edits.delete(id); render(); return; }
        const expectedRevision = snapshot.settings.settingsRevision;
        const overrides = Object.fromEntries(Object.entries(snapshot.settings.modelDescriptionOverrides || {}));
        if (nextValue === null) delete overrides[id];
        else Object.defineProperty(overrides, id, { value: nextValue, enumerable: true, configurable: true, writable: true });
        options.busy(true);
        try {
          const next = await options.save(overrides, expectedRevision);
          snapshot = next;
          edits.delete(id);
          options.committed(next, expectedRevision);
          render();
          options.busy(false, copy(restore || nextValue === null ? "restored" : "saved"));
        } catch (error) {
          if (String(error && error.message || error).includes("SETTINGS_REVISION_CONFLICT")) {
            try {
              snapshot = await options.reload();
              const pending = edits.get(id);
              if (pending) { pending.expectedOverride = saved(id); pending.error = "conflict"; }
              render();
              options.busy(false);
              options.error(copy("conflict"));
            } catch (refreshError) { options.busy(false); options.error(refreshError); }
          } else { options.busy(false); options.error(error); }
        }
      }
      function render() {
        if (!snapshot) return;
        root.parentElement.hidden = !snapshot.settings.modelDescriptionOverrides;
        root.replaceChildren();
        const catalog = models();
        const ids = [...new Set([...catalog.keys(), ...Object.keys(snapshot.settings.modelDescriptionOverrides || {}), ...edits.keys()])].sort();
        for (const id of ids) {
          const model = catalog.get(id), override = saved(id), edit = edits.get(id);
          const official = model && model.description || "";
          const row = node("article", undefined, "model-description-row");
          row.dataset.model = id;
          const header = node("div", undefined, "model-description-header");
          header.append(node("h3", model && model.displayName || id));
          const source = node("span", copy(override === null ? "official" : "user"), "hint model-description-source");
          source.dataset.descriptionSource = override === null ? "catalog" : "user";
          header.append(source);
          if (!edit) header.append(button(copy("edit"), "edit", () => beginEdit(id, official)));
          row.append(header);
          if (!model) row.append(node("p", copy("unavailable"), "hint"));
          if (!edit || edit.error) row.append(node("p", override === null ? official || copy("empty") : override, "model-description-text"));
          if (edit) {
            const label = node("label", copy("label"));
            const input = node("textarea");
            input.rows = 4;
            input.maxLength = limit;
            input.value = edit.text;
            input.disabled = blocked;
            label.append(input);
            row.append(label, node("p", copy("limit"), "hint"));
            const actions = node("div", undefined, "model-description-actions");
            const save = button(copy("save"), "save", () => void persist(id, false));
            const validate = () => {
              const invalid = edit.text.trim().length > limit;
              input.setCustomValidity(invalid ? copy("tooLong") : "");
              save.dataset.invalid = String(invalid);
              save.disabled = blocked || invalid;
            };
            input.addEventListener("input", () => { edit.text = input.value; validate(); });
            validate();
            actions.append(save, button(options.cancelText(), "cancel", () => { edits.delete(id); render(); }));
            row.append(actions);
            if (edit.error) row.append(node("p", copy(edit.error), "model-description-error"));
          }
          if (override !== null || edit) {
            const details = node("details", undefined, "model-description-official");
            details.open = expanded.has(id);
            details.append(node("summary", copy("compare")), node("p", official || copy("empty"), "model-description-text hint"));
            details.addEventListener("toggle", () => { if (details.open) expanded.add(id); else expanded.delete(id); });
            row.append(details);
          }
          if (override !== null && !edit) row.append(button(copy("restore"), "restore", () => void persist(id, true)));
          root.append(row);
        }
      }
      return {
        setSnapshot(next) {
          if (snapshot && next.settings.settingsRevision < snapshot.settings.settingsRevision) return;
          snapshot = next;
          render();
        },
        refresh: render,
        reset() { edits.clear(); },
        setDisabled(value) {
          blocked = value;
          for (const element of root.querySelectorAll("button,textarea")) element.disabled = value || element.dataset.invalid === "true";
        }
      };
    }
`;
