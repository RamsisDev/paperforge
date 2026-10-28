import { BookOpen, Images, ListTree, Settings2 } from "lucide-react";
import { store, useStore, type SidebarTab } from "@/store";
import { FiguresPanel } from "./sidebar/FiguresPanel";
import { OutlinePanel } from "./sidebar/OutlinePanel";
import { PaperPanel } from "./sidebar/PaperPanel";
import { ReferencesPanel } from "./sidebar/ReferencesPanel";
import { Tabs } from "./ui";

const PANELS: Record<SidebarTab, () => React.JSX.Element | null> = {
  paper: PaperPanel,
  outline: OutlinePanel,
  refs: ReferencesPanel,
  figures: FiguresPanel,
};

export function Sidebar() {
  const tab = useStore((s) => s.sidebarTab);
  const Panel = PANELS[tab];
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <Tabs
        className="h-9 shrink-0 border-b border-line px-1.5"
        value={tab}
        onChange={(sidebarTab) => store.set({ sidebarTab })}
        tabs={[
          { id: "paper", label: "Paper", icon: <Settings2 size={13} /> },
          { id: "outline", label: "Outline", icon: <ListTree size={13} /> },
          { id: "refs", label: "Refs", icon: <BookOpen size={13} /> },
          { id: "figures", label: "Figures", icon: <Images size={13} /> },
        ]}
      />
      <div className="min-h-0 flex-1 overflow-auto">
        <Panel />
      </div>
    </div>
  );
}
