/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        anvil: {
          bg: "#0e1116",
          panel: "#151a22",
          raised: "#1d2430",
          line: "#2a3342",
          text: "#e5eaf2",
          muted: "#8b95a7",
          accent: "#7dd3fc",
          green: "#86efac",
          amber: "#fcd34d",
          red: "#fca5a5"
        }
      }
    }
  },
  plugins: []
};
