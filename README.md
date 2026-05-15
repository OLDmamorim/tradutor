# Tradutor de Documentos

Aplicacao web para traduzir documentos mantendo a estrutura original sempre que o formato permite.

## Versao inicial

- `.docx`: traduz texto em corpo, cabecalhos, rodapes, notas e comentarios.
- `.pptx`: traduz texto em slides, notas e layouts.
- `.xlsx`: traduz strings partilhadas e texto inline nas folhas.
- `.pdf`: traduz PDFs com texto pesquisavel, usando a pagina original como fundo e escrevendo a traducao por cima.
- `.txt`: traduz texto simples.

PDFs digitalizados como imagem ainda precisam de OCR numa fase seguinte.

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
