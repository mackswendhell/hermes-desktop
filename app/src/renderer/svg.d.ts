// o esbuild carrega .svg com loader 'text'
declare module '*.svg' {
  const content: string;
  export default content;
}

// o worker do pdf.js entra como texto e vira blob em runtime
declare module 'pdfjs-dist/legacy/build/pdf.worker.min.mjs' {
  const content: string;
  export default content;
}
