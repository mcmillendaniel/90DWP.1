/** Wake-confirmation modal and its tone-adaptive messaging. */
import { $ } from "./dom.js";
import { state, dayKey } from "./state.js";

let wakeModalEl = null;

function ensureWakeModal(){
  if(wakeModalEl) return wakeModalEl;
  const wrap = document.createElement("div");
  wrap.className = "wake-modal";
  wrap.id = "wakeModal";
  wrap.innerHTML = `
    <div class="wake-card">
      <div class="wake-title">Wake confirmed.</div>
      <div class="wake-msg" id="wakeMsg">Stand up. Move your body.</div>
      <div class="wake-sub" id="wakeSub">Small wins first. No debating.</div>
      <button class="wake-btn" id="wakeBtn">Hell yeah, brother</button>
    </div>
  `;
  document.body.appendChild(wrap);
  wakeModalEl = wrap;
  return wakeModalEl;
}

export function openWakeModal({ message, subtext, onDismiss }){
  ensureWakeModal();
  document.body.classList.add("locked");
  $("wakeMsg").textContent = message;
  $("wakeSub").textContent = subtext;
  wakeModalEl.classList.add("show");
  $("wakeBtn").onclick = () => {
    wakeModalEl.classList.remove("show");
    document.body.classList.remove("locked");
    if(typeof onDismiss === "function") onDismiss();
  };
}

function getWakeStats(){
  const keys = Object.keys(state.days).sort();
  const last7 = keys.slice(-7);
  const wakeTimes = [];
  for(const k of last7){
    const ts = state.days[k]?.events?.imUp;
    if(ts){
      const d = new Date(ts);
      wakeTimes.push(d.getHours() * 60 + d.getMinutes());
    }
  }
  let streak = 0;
  for(const k of Object.keys(state.days).sort().reverse()){
    if(!state.days[k]?.events?.imUp) break;
    streak += 1;
    if(streak >= 14) break;
  }
  let consistencyScore = 0;
  if(wakeTimes.length >= 3){
    const range = Math.max(...wakeTimes) - Math.min(...wakeTimes);
    consistencyScore = Math.max(0, Math.min(1, 1 - (range / 90)));
  }
  return { streakDays: streak, consistencyScore };
}

/** Tone shifts from push to steady as the streak and consistency build. */
export function pickWakeMessage(){
  try {
    const { streakDays, consistencyScore } = getWakeStats();
    const supportiveGate = (streakDays >= 7) || (streakDays >= 4 && consistencyScore >= 0.6);
    const mixedGate = (streakDays >= 3);
    const hype = [
      "Feet on floor. Stand up now. No negotiations.",
      "Up. Water. Move. We're not thinking—just executing.",
      "Get vertical. Your day starts when you move.",
      "Stand up. One small win in the next 10 minutes. Go."
    ];
    const mixed = [
      "Alright—let's move. Small wins first, momentum second.",
      "Up we go. One 10-minute action to start the chain.",
      "Stand up, breathe, move. Then we decide the first win."
    ];
    const dad = [
      "Up we go—quiet, steady, on purpose. One small win first.",
      "Good morning. Let's secure the day with three simple outcomes.",
      "We're building consistency. One step, then the next."
    ];
    const pool = supportiveGate ? dad : (mixedGate ? mixed : hype);
    const seed = dayKey().split("-").join("");
    const message = pool[Number(seed) % pool.length];
    const subtext = supportiveGate
      ? `Streak: ${streakDays} day(s). Consistency: ${(consistencyScore * 100) | 0}%`
      : mixedGate
        ? `Streak: ${streakDays} day(s). Keep it small and clean.`
        : `We start before we feel ready.`;
    return { message, subtext };
  } catch {
    return { message: "Stand up. Move your body.", subtext: "Small wins first." };
  }
}
