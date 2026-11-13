/** Invite payload: Base64 of `v1,{network_name},{network_secret},{host_ipv4},{port}[,peer]` */
export const HOST_VIRTUAL_IP = "10.126.126.1";

export type DecodedInvite = {
  version: string;
  networkName: string;
  networkSecret: string;
  hostIpv4: string;
  port: string;
  peer?: string;
};

function decodeBase64Utf8(encoded: string): string {
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function decodeInvite(encodedInvite: string): DecodedInvite | null {
  const trimmed = encodedInvite.trim();
  if (!trimmed) return null;

  try {
    const text = decodeBase64Utf8(trimmed);
    // peer 可能含冒号，只按前 5 个逗号切分
    const parts = text.split(",");
    if (parts.length < 5) return null;

    const version = parts[0]?.trim() ?? "";
    const networkName = parts[1]?.trim() ?? "";
    const networkSecret = parts[2]?.trim() ?? "";
    const hostIpv4 = parts[3]?.trim() ?? "";
    const port = parts[4]?.trim() ?? "";
    const peer = parts.length >= 6 ? parts.slice(5).join(",").trim() : undefined;

    if (version !== "v1" || !networkName || !networkSecret || !hostIpv4 || !port) {
      return null;
    }

    return {
      version,
      networkName,
      networkSecret,
      hostIpv4,
      port,
      peer: peer || undefined,
    };
  } catch {
    return null;
  }
}

export function formatHostAddress(invite: Pick<DecodedInvite, "hostIpv4" | "port">): string {
  return `${invite.hostIpv4}:${invite.port}`;
}
