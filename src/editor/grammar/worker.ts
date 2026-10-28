// `no-inline` keeps the 20 MB binary an asset fetched on first use, never a data: URL.
import wasmUrl from "../../../node_modules/harper.js/dist/harper_wasm_slim_bg.wasm?url&no-inline";
import { harperLinter } from "./harper";
import type { GrammarRequest, GrammarResponse } from "./protocol";

// The project compiles against the DOM lib; the webworker lib cannot be mixed into it.
const scope = self as unknown as {
  onmessage: (event: MessageEvent<GrammarRequest>) => void;
  postMessage: (response: GrammarResponse) => void;
};

const lint = harperLinter(wasmUrl);

scope.onmessage = async (event) => {
  const { id, dialect, texts } = event.data;
  let response: GrammarResponse;
  try {
    response = { id, ok: true, lints: await lint(dialect, texts) };
  } catch (e) {
    response = { id, ok: false, error: String(e) };
  }
  scope.postMessage(response);
};
