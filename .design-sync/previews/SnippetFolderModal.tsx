import { SnippetFolderModal } from "anyscp";
import { noop } from "./_fixtures";

const Frame = ({ children }: { children: React.ReactNode }) => <div className="bg-bg-base" style={{ width: 960, height: 680 }}>{children}</div>;

export const NewFolder = () => <Frame><SnippetFolderModal open onClose={noop} onSave={async () => {}} /></Frame>;
