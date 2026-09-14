import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "세종톡",
  description: "세종과 글과 음성으로 대화하는 교육용 웹 서비스",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ko"><body>{children}</body></html>;
}
