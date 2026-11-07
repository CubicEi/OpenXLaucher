const STORAGE_KEY = "openx-onboarding:v1";
const RESUME_SESSION_KEY = "openx-onboarding-resume";
export const ONBOARDING_COMPLETE_EVENT = "openx-onboarding-complete";

export type OnboardingResumeStep = "instance";

type OnboardingState = {
  complete: boolean;
};

function readState(): OnboardingState {
  if (typeof window === "undefined") return { complete: false };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { complete: false };
    const parsed = JSON.parse(raw) as Partial<OnboardingState>;
    return { complete: Boolean(parsed.complete) };
  } catch {
    return { complete: false };
  }
}

function writeState(patch: Partial<OnboardingState>): void {
  if (typeof window === "undefined") return;
  try {
    const next: OnboardingState = { ...readState(), ...patch };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota / private mode */
  }
}

export function isOnboardingComplete(): boolean {
  return readState().complete;
}

/** 开箱未完成时推迟启动更新弹窗（后台仍可检查更新）。 */
export function shouldDeferStartupUpdatePrompt(): boolean {
  return !isOnboardingComplete();
}

export function markOnboardingComplete(): void {
  const already = isOnboardingComplete();
  writeState({ complete: true });
  clearOnboardingResume();
  if (!already && typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(ONBOARDING_COMPLETE_EVENT));
  }
}

export function subscribeOnboardingComplete(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => listener();
  window.addEventListener(ONBOARDING_COMPLETE_EVENT, handler);
  return () => window.removeEventListener(ONBOARDING_COMPLETE_EVENT, handler);
}

export function setOnboardingResume(step: OnboardingResumeStep): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(RESUME_SESSION_KEY, step);
  } catch {
    /* ignore */
  }
}

export function getOnboardingResume(): OnboardingResumeStep | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(RESUME_SESSION_KEY);
    return raw === "instance" ? "instance" : null;
  } catch {
    return null;
  }
}

export function clearOnboardingResume(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(RESUME_SESSION_KEY);
  } catch {
    /* ignore */
  }
}
