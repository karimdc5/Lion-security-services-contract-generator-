import QRCode from "qrcode";

/**
 * Server-rendered QR. Generating the data URL on the server keeps the QR
 * library out of the client bundle and means the client page works without JS.
 */
export async function QrCode({
  value,
  size = 256,
  alt,
}: {
  value: string;
  size?: number;
  alt: string;
}) {
  const dataUrl = await QRCode.toDataURL(value, {
    width: size,
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#0b1220", light: "#ffffff" },
  });

  return (
    // eslint-disable-next-line @next/next/no-img-element -- data: URL, no loader needed
    <img
      src={dataUrl}
      alt={alt}
      width={size}
      height={size}
      className="rounded-lg border border-line bg-white"
    />
  );
}
