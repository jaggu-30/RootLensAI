/** @type {import('tailwindcss').Config} */
export default { content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'], theme: { extend: { fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui'] }, colors: { ink: '#08111f', panel: '#101c2d', line: '#223249', mint: '#8cf2cb' }, boxShadow: { glow: '0 0 35px rgba(140,242,203,.08)' } } }, plugins: [] }
