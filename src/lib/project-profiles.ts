import { ModelSelectionPreset } from "./run-presets";

export interface ProjectProfile {
  id: string;
  name: string;
  description: string;
  defaultRunPresetId: string;
  defaultModelPreset: ModelSelectionPreset;
  defaultSynthesisModel: "sonnet" | "opus";
  defaultMaxCost: number;
  defaultContextPackName?: string;
}

const CUSTOM_PROFILES_KEY = "model-prism-project-profiles";
const ACTIVE_PROFILE_KEY = "model-prism-active-profile";

export const BUILT_IN_PROJECT_PROFILES: ProjectProfile[] = [
  {
    id: "luxury-apartments",
    name: "LuxuryApartments",
    description: "Next.js/Supabase luxury apartment marketplace with AI infra and plan-review hooks.",
    defaultRunPresetId: "plan-review",
    defaultModelPreset: "diverse",
    defaultSynthesisModel: "opus",
    defaultMaxCost: 1.5,
    defaultContextPackName: "LuxuryApartments",
  },
  {
    id: "pi-desktop",
    name: "Pi Desktop",
    description: "Electron desktop UI around pi RPC, focused on safe visual coding workflows.",
    defaultRunPresetId: "code-review",
    defaultModelPreset: "diverse",
    defaultSynthesisModel: "sonnet",
    defaultMaxCost: 0.75,
    defaultContextPackName: "Pi Desktop",
  },
  {
    id: "model-prism",
    name: "Model Prism",
    description: "Multi-model council, synthesis, context packs, and plan review automation.",
    defaultRunPresetId: "architecture-review",
    defaultModelPreset: "frontier",
    defaultSynthesisModel: "opus",
    defaultMaxCost: 1.25,
    defaultContextPackName: "Model Prism",
  },
];

export function getCustomProjectProfiles(): ProjectProfile[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOM_PROFILES_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveCustomProjectProfiles(profiles: ProjectProfile[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(CUSTOM_PROFILES_KEY, JSON.stringify(profiles));
}

export function getProjectProfiles(): ProjectProfile[] {
  return [...BUILT_IN_PROJECT_PROFILES, ...getCustomProjectProfiles()];
}

export function getActiveProjectProfileId(): string {
  if (typeof window === "undefined") return BUILT_IN_PROJECT_PROFILES[0].id;
  return localStorage.getItem(ACTIVE_PROFILE_KEY) || BUILT_IN_PROJECT_PROFILES[0].id;
}

export function setActiveProjectProfileId(id: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(ACTIVE_PROFILE_KEY, id);
}

export function createProjectProfile(input: Omit<ProjectProfile, "id">): ProjectProfile {
  return {
    ...input,
    id: `profile_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
  };
}
