import { Suspense, lazy, useEffect } from "react";
import { openProjectAt } from "@/actions";
import { FolderPickerHost } from "@/components/FolderPicker";
import { TemplateGallery } from "@/components/TemplateGallery";
import { Toaster } from "@/components/Toaster";
import { api } from "@/lib/api";
import { Welcome } from "@/components/Welcome";
import { flushSaves } from "@/session";
import { useStore } from "@/store";

// The editor, pdf.js and KaTeX load after the welcome screen is already on screen.
const loadWorkspace = () => import("@/components/Workspace");
const Workspace = lazy(() => loadWorkspace().then((m) => ({ default: m.Workspace })));

export default function App() {
  const dir = useStore((s) => s.dir);
  const theme = useStore((s) => s.theme);
  const gallery = useStore((s) => s.gallery);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 300));
    idle(() => void loadWorkspace());
    api
      .startupProject()
      .then((path) => (path ? openProjectAt(path) : undefined))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onHide = () => void flushSaves();
    window.addEventListener("beforeunload", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("beforeunload", onHide);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, []);

  return (
    <>
      {dir ? (
        <Suspense fallback={null}>
          <Workspace />
        </Suspense>
      ) : (
        <Welcome />
      )}
      {gallery && (gallery === "create" || dir) && <TemplateGallery mode={gallery} />}
      <FolderPickerHost />
      <Toaster />
    </>
  );
}
