import { describe, expect, it } from "vitest";
import { parseInvite } from "./invite";

// `JoinCode { ip: 192.168.1.37, port: 1440, secret: [0, 255, 7, 128, 42] }` as Rust encodes it.
const CODE = "60N00J-A1D003-ZGF01A";

describe("parseInvite", () => {
  it("decodes the host's address from a code", () => {
    expect(parseInvite(CODE)).toEqual({ code: CODE, host: "192.168.1.37:1440" });
  });

  it("tolerates case, spaces and look-alike letters", () => {
    expect(parseInvite(" 6on0oj a1dOo3 zgfolA ")).toEqual({ code: CODE, host: "192.168.1.37:1440" });
  });

  it("takes the address of a link", () => {
    expect(parseInvite(`http://10.0.0.8:1500/#join=${CODE}`)).toEqual({ code: CODE, host: "10.0.0.8:1500" });
  });

  it("rejects anything else", () => {
    expect(parseInvite(CODE.slice(0, -1))).toBeNull();
    expect(parseInvite(`${CODE}0`)).toBeNull();
    expect(parseInvite("ZZZZZZ-ZZZZZZ-ZZZZZZ")).toBeNull();
    expect(parseInvite("http://10.0.0.8:1500/")).toBeNull();
  });
});
