# Taiwan Invoice OCR Panel

Local-first Taiwan triplicate invoice OCR panel for organizing handwritten invoices and exporting confirmed records to Excel.

The workflow is designed for local use:

1. PaddleOCR reads text and bounding boxes from invoice images.
2. Layout rules extract invoice number, buyer tax ID, items, quantity, and unit price.
3. Amounts are calculated by formula, not trusted directly from OCR.
4. Ollama with `qwen2.5vl:7b` assists only low-confidence fields.
5. Users manually review and confirm records before they become official.
6. Excel export contains official fields only, not raw OCR text.

## Privacy

This project is designed to run locally. It does not call Google Vision, OpenAI Vision, or paid cloud OCR APIs. Uploaded images stay in `data/uploads`, and records stay in `data/records.json`.

Do not commit real invoice images, debug JSON, company stamps, tax IDs, addresses, or filled `records.json` files.

## Requirements

- macOS, preferably Apple Silicon
- Node.js 20+
- Python 3.10-3.13
- Ollama
- Ollama model:

```bash
ollama pull qwen2.5vl:7b
```

## Quick Start

Install frontend dependencies:

```bash
npm ci
```

Start PaddleOCR service in one terminal:

```bash
cd ocr-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8765
```

Start the web app in another terminal:

```bash
npm run build
npm run start -- -p 3000
```

Open:

```text
http://localhost:3000
```

On macOS you can also use:

```bash
./PaddleOCR服務-啟動.command
./財務收據整理面板-啟動.command
```

## Documentation

- [Install Guide](docs/INSTALL.md)
- [OCR Flow](docs/OCR_FLOW.md)
- [Privacy Notes](docs/PRIVACY.md)

## Test

```bash
npm test
npm run build
npm run doctor
```

## License

MIT
