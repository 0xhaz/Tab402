import { ImageResponse } from "next/og";

/**
 * App icons, drawn from the brand mark (no binary assets in the repo). Maskable icons keep the
 * mark inside the 80% safe zone; the badge is a white glyph on transparent for Android's status bar.
 */
const ICONS: Record<string, { size: number; inset: number; radius: number; badge?: boolean }> = {
  "icon-192.png": { size: 192, inset: 0, radius: 40 },
  "icon-512.png": { size: 512, inset: 0, radius: 104 },
  "maskable-512.png": { size: 512, inset: 0.2, radius: 0 },
  "apple-touch-180.png": { size: 180, inset: 0, radius: 0 },
  "badge-96.png": { size: 96, inset: 0, radius: 0, badge: true },
};

export const dynamic = "force-static";
export const generateStaticParams = () => Object.keys(ICONS).map((name) => ({ name }));

export async function GET(_: Request, { params }: { params: Promise<{ name: string }> }) {
  const icon = ICONS[(await params).name];
  if (!icon) return new Response("not found", { status: 404 });
  const { size, inset, radius, badge } = icon;
  const glyph = Math.round(size * (1 - inset * 2) * 0.36);
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: badge ? "transparent" : "#245fd4",
        borderRadius: radius,
        color: "#ffffff",
        fontSize: glyph,
        fontWeight: 800,
        letterSpacing: -glyph * 0.04,
        fontFamily: "monospace",
      }}
    >
      402
    </div>,
    { width: size, height: size },
  );
}
