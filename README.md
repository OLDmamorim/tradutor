# Tradutor de Documentos

Aplicacao web para traduzir documentos mantendo a estrutura original sempre que o formato permite.

## Versao inicial

- `.docx`: traduz texto em corpo, cabecalhos, rodapes, notas e comentarios.
- `.pptx`: traduz texto em slides, notas e layouts.
- `.xlsx`: traduz strings partilhadas e texto inline nas folhas.
- `.txt`: traduz texto simples.

PDF fica preparado como proxima fase. Manter layout de PDF com fidelidade alta exige um fluxo proprio de OCR/layout ou conversao para DOCX antes da traducao.

## Como correr localmente

1. Instalar dependencias:

```bash
npm install
```

2. Criar `.env` com base em `.env.example` e preencher `OPENAI_API_KEY`.

3. Arrancar:

```bash
npm run dev
```

## Deploy no Netlify

1. Criar um site no Netlify ligado a este repositorio.
2. Definir as variaveis de ambiente:
   - `OPENAI_API_KEY`
   - `OPENAI_MODEL` opcional, por defeito `gpt-5.2`
3. Build command: `npm run build`
4. Publish directory: `public`

## Fase seguinte

Neon so e necessario quando quisermos contas de utilizador, historico, creditos, auditoria ou fila de trabalhos demorados.
