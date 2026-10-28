import { BookOpen, History, Images, ListTree, MessageSquare, Search, Settings2 } from "lucide-react";
import { store, useStore, type SidebarTab } from "@/store";
import { CommentsPanel } from "./sidebar/CommentsPanel";
import { FiguresPanel } from "./sidebar/FiguresPanel";
import { FindPanel } from "./sidebar/FindPanel";
import { HistoryPanel } from "./sidebar/HistoryPanel";
import { PaperPanel } from "./sidebar/PaperPanel";
import { ReferencesPanel } from "./sidebar/ReferencesPanel";
import { StructurePanel } from "./sidebar/StructurePanel";
import { Tabs } from "./ui";

const PANELS: Record<SidebarTab, () => React.ReactNode> = {
  paper: PaperPanel,
  structure: StructurePanel,
  refs: ReferencesPanel,
  figures: FiguresPanel,
  find: FindPanel,
  comments: CommentsPanel,
  history: HistoryPanel,
};

export function Sidebar() {
  const tab = useStore((s) => s.sidebarTab);
  const Panel = PANELS[tab];
  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      <Tabs
        className="h-9 shrink-0 border-b border-line px-1.5"
        compact
        value={tab}
        onChange={(sidebarTab) => store.set({ sidebarTab })}
        tabs={[
          { id: "paper", label: "Paper", icon: <Settings2 size={13} /> },
          { id: "structure", label: "Structure", icon: <ListTree size={13} /> },
          { id: "refs", label: "Refs", icon: <BookOpen size={13} /> },
          { id: "figures", label: "Figures", icon: <Images size={13} /> },
          { id: "find", label: "Find", icon: <Search size={13} /> },
          { id: "comments", label: "Review", icon: <MessageSquare size={13} /> },
          { id: "history", label: "History", icon: <History size={13} /> },
        ]}
      />
      <div key={tab} className="min-h-0 flex-1 overflow-auto">
        <Panel />
      </div>
    </div>
  );
}
