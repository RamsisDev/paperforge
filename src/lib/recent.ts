export interface RecentProject {
  dir: string;
  title: string;
  openedAt: number;
}

const KEY = "paperforge.recent";
const LIMIT = 8;

export function recentProjects(): RecentProject[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as RecentProject[];
  } catch {
    return [];
  }
}

export function rememberProject(dir: string, title: string) {
  const rest = recentProjects().filter((p) => p.dir !== dir);
  localStorage.setItem(KEY, JSON.stringify([{ dir, title, openedAt: Date.now() }, ...rest].slice(0, LIMIT)));
}

export function forgetProject(dir: string) {
  localStorage.setItem(KEY, JSON.stringify(recentProjects().filter((p) => p.dir !== dir)));
}
