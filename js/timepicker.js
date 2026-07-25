/**
 * Two-step time editor: a confirmation sheet, then a scrollable drum picker.
 * Resolves to a new timestamp, or null if cancelled at either step.
 */

const ITEM_H = 44;
const COLUMN_H = 160;

function initDrum(drumEl, values, startIndex){
  drumEl.innerHTML = "";
  values.forEach(v => {
    const el = document.createElement("div");
    el.className = "te-drum-item";
    el.textContent = v;
    drumEl.appendChild(el);
  });

  // Pad so the selected item sits centred under the highlight band.
  const padPx = (COLUMN_H - ITEM_H) / 2;
  drumEl.style.paddingTop = padPx + "px";
  drumEl.style.paddingBottom = padPx + "px";

  let currentIdx = startIndex;
  let startY = 0, startOffset = 0;
  let offset = startIndex * ITEM_H;

  const clamp = (v) => Math.max(0, Math.min((values.length - 1) * ITEM_H, v));

  function applyOffset(o, animate){
    drumEl.style.transition = animate ? "transform .15s ease" : "none";
    drumEl.style.transform = `translateY(${-o}px)`;
  }

  function snapTo(idx){
    currentIdx = Math.round(Math.max(0, Math.min(values.length - 1, idx)));
    offset = currentIdx * ITEM_H;
    applyOffset(offset, true);
  }

  applyOffset(offset, false);

  drumEl.addEventListener("touchstart", e => {
    startY = e.touches[0].clientY;
    startOffset = offset;
    drumEl.style.transition = "none";
  }, { passive: true });

  // Not passive: dragging the drum must not scroll the page behind it.
  drumEl.addEventListener("touchmove", e => {
    e.preventDefault();
    offset = clamp(startOffset + (startY - e.touches[0].clientY));
    applyOffset(offset, false);
  }, { passive: false });

  drumEl.addEventListener("touchend", () => snapTo(Math.round(offset / ITEM_H)));

  drumEl.addEventListener("mousedown", e => {
    startY = e.clientY;
    startOffset = offset;
    drumEl.style.transition = "none";
    const onMove = ev => {
      offset = clamp(startOffset + (startY - ev.clientY));
      applyOffset(offset, false);
    };
    const onUp = () => {
      snapTo(Math.round(offset / ITEM_H));
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });

  return { getValue: () => values[currentIdx] };
}

function openOverlay(id){
  const el = document.getElementById(id);
  el.classList.add("open");
  el.setAttribute("aria-hidden", "false");
}

function closeOverlay(id){
  const el = document.getElementById(id);
  el.classList.remove("open");
  el.setAttribute("aria-hidden", "true");
}

export function openTimeEditFlow(existingTs){
  return new Promise(resolve => {
    const existing = new Date(existingTs);

    // Step 1: confirm the user meant to edit rather than re-log.
    document.getElementById("editConfirmSub").textContent =
      `Currently logged: ${existing.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
    openOverlay("editConfirmModal");

    const onCancel = () => { closeOverlay("editConfirmModal"); cleanupConfirm(); resolve(null); };
    const onYes = () => { closeOverlay("editConfirmModal"); cleanupConfirm(); openPicker(); };

    document.getElementById("editConfirmCancel").addEventListener("click", onCancel);
    document.getElementById("editConfirmYes").addEventListener("click", onYes);

    function cleanupConfirm(){
      document.getElementById("editConfirmCancel").removeEventListener("click", onCancel);
      document.getElementById("editConfirmYes").removeEventListener("click", onYes);
    }

    // Step 2: the drum picker.
    function openPicker(){
      const HOURS = ["1","2","3","4","5","6","7","8","9","10","11","12"];
      const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));
      const AMPM = ["AM", "PM"];

      const h24 = existing.getHours();
      const ampmIdx = h24 >= 12 ? 1 : 0;
      const hourIdx = HOURS.indexOf(String(h24 % 12 || 12));

      const dHour = initDrum(document.getElementById("drumHour"), HOURS, hourIdx < 0 ? 0 : hourIdx);
      const dMin = initDrum(document.getElementById("drumMin"), MINUTES, existing.getMinutes());
      const dAmPm = initDrum(document.getElementById("drumAmPm"), AMPM, ampmIdx);

      openOverlay("editPickerModal");

      const onPickerCancel = () => { closeOverlay("editPickerModal"); cleanupPicker(); resolve(null); };
      const onPickerConfirm = () => {
        closeOverlay("editPickerModal");
        cleanupPicker();

        let hours = parseInt(dHour.getValue(), 10);
        const mins = parseInt(dMin.getValue(), 10);
        const ap = dAmPm.getValue();
        if(ap === "AM" && hours === 12) hours = 0;
        if(ap === "PM" && hours !== 12) hours += 12;

        // Keep the original calendar date, change only the time of day.
        const base = new Date(existingTs);
        base.setHours(hours, mins, 0, 0);
        resolve(base.getTime());
      };

      document.getElementById("editPickerCancel").addEventListener("click", onPickerCancel);
      document.getElementById("editPickerConfirm").addEventListener("click", onPickerConfirm);

      function cleanupPicker(){
        document.getElementById("editPickerCancel").removeEventListener("click", onPickerCancel);
        document.getElementById("editPickerConfirm").removeEventListener("click", onPickerConfirm);
      }
    }
  });
}
