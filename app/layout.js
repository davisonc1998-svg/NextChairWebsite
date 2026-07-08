import "./globals.css";

export const metadata = {
  title: "NextChair — Does AI recommend your barbershop?",
  description:
    "Free check: see whether ChatGPT, Gemini, Claude and Perplexity recommend your barbershop when locals ask for the best barber in town.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en-GB">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Oswald:wght@400;500;600;700&family=Inter:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
