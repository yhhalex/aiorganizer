import "./globals.css";

export const metadata = {
  title: "AI Organizer Prototype",
  description: "Local-first AI Organizer prototype"
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
