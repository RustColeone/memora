"""
LLM Service for AI-powered entry generation
Supports OpenAI GPT-4 Vision and Google Gemini Vision
"""

import os
import json
import base64
from typing import Dict, List, Optional, Any

from services import claude_llm

# Optional LLM provider SDKs
try:
    from openai import OpenAI
    _openai_available = True
except Exception:
    OpenAI = None
    _openai_available = False

try:
    import google.generativeai as genai
    _gemini_available = True
except Exception:
    genai = None
    _gemini_available = False


def openai_reasoning(model: Optional[str]) -> bool:
    """OpenAI's reasoning models (o-series, GPT-5 and later) reject temperature and
    max_tokens, and on Chat Completions call tools only with reasoning_effort "none"."""
    import re
    return bool(re.match(r'^(o\d|gpt-[5-9])', model or '', re.I))


def openai_sampling(model: Optional[str], temperature: float, max_tokens: Optional[int]) -> Dict[str, Any]:
    """Sampling arguments that this OpenAI-compatible model accepts."""
    if openai_reasoning(model):
        return {'max_completion_tokens': max_tokens} if max_tokens else {}
    out: Dict[str, Any] = {'temperature': temperature}
    if max_tokens:
        out['max_tokens'] = max_tokens
    return out


def vision_capable(provider: Optional[str], model: Optional[str] = None) -> bool:
    """Whether this provider/model reads images. DeepSeek's Flash models do,
    its Pro model does not; a custom service is assumed not to."""
    provider = (provider or '').lower()
    if provider == 'deepseek':
        return not model or 'flash' in model.lower()
    return provider in LLMService._VISION_PROVIDERS


class LLMService:
    """Service for analyzing files/images and generating memo entries using LLM"""
    
    def __init__(
        self,
        provider: str = 'gemini',
        openai_api_key: Optional[str] = None,
        gemini_api_key: Optional[str] = None,
        deepseek_api_key: Optional[str] = None,
        model: Optional[str] = None,
        anthropic_api_key: Optional[str] = None,
        custom_api_key: Optional[str] = None,
        custom_base_url: Optional[str] = None,
    ):
        """
        Initialize LLM Service

        Args:
            provider: 'openai', 'gemini', or 'deepseek'
            openai_api_key: OpenAI API key (or from env OPENAI_API_KEY)
            gemini_api_key: Google Gemini API key (or from env GEMINI_API_KEY)
            deepseek_api_key: DeepSeek API key (or from env DEEPSEEK_API_KEY)
            model: Specific model to use (optional, uses defaults)
        """
        self.provider = (provider or 'gemini').lower()
        self.openai_api_key = openai_api_key or os.environ.get('OPENAI_API_KEY')
        self.gemini_api_key = gemini_api_key or os.environ.get('GEMINI_API_KEY')
        self.deepseek_api_key = deepseek_api_key or os.environ.get('DEEPSEEK_API_KEY')
        # Claude (services/claude_llm.py) and any OpenAI-compatible service.
        self.anthropic_api_key = anthropic_api_key or os.environ.get('ANTHROPIC_API_KEY')
        self.custom_api_key = custom_api_key or os.environ.get('LLM_CUSTOM_API_KEY')
        self.custom_base_url = custom_base_url or os.environ.get('LLM_CUSTOM_BASE_URL')

        # Set default models if not specified
        if model:
            self.model = model
        else:
            if self.provider == 'openai':
                self.model = 'gpt-6-luna'
            elif self.provider == 'gemini':
                self.model = 'gemini-3.8-flash'
            elif self.provider == 'deepseek':
                self.model = 'deepseek-flash'
            elif self.provider == 'anthropic':
                self.model = claude_llm.DEFAULT_MODEL
            else:
                self.model = None

        # Initialize clients
        self.openai_client = None
        self.gemini_model = None
        self.deepseek_client = None
        self.custom_client = None

        if self.provider == 'openai' and _openai_available and self.openai_api_key:
            self.openai_client = OpenAI(api_key=self.openai_api_key)

        if self.provider == 'deepseek' and _openai_available and self.deepseek_api_key:
            self.deepseek_client = OpenAI(
                api_key=self.deepseek_api_key,
                base_url='https://api.deepseek.com',
            )

        if self.provider == 'custom' and _openai_available and self.custom_api_key and self.custom_base_url:
            self.custom_client = OpenAI(api_key=self.custom_api_key, base_url=self.custom_base_url)

        if self.provider == 'gemini' and _gemini_available and self.gemini_api_key:
            genai.configure(api_key=self.gemini_api_key)
            self.gemini_model = genai.GenerativeModel(self.model)
    
    def analyze_files_for_entry(
        self,
        file_paths: List[str],
        user_message: str,
        variant: str = 'default',
        base_dir: str = '.',
        ocr_texts: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """
        Analyze uploaded files and generate entry metadata
        
        Args:
            file_paths: List of file paths relative to base_dir (e.g., ['/uploads/2025-01-01/image.jpg'])
            user_message: Optional user-provided context
            variant: 'default' or 'finance'
            base_dir: Base directory for file resolution
            ocr_texts: Optional mapping of absolute file path -> extracted OCR text to be used as ground truth when present
            
        Returns:
            Dictionary with entry metadata: description, category, tags, and finance fields if applicable
        """
        # Build system prompt based on variant
        system_prompt = self._build_system_prompt(variant)
        
        # Build user prompt (seed with OCR text if provided)
        user_prompt = user_message if user_message else "Analyze the uploaded file(s) and extract relevant information."
        
        # Prepare file data for vision analysis
        file_data = []
        for file_path in file_paths:
            # Convert relative path to absolute
            abs_path = os.path.join(base_dir, file_path.lstrip('/'))
            if os.path.exists(abs_path):
                file_data.append({
                    'path': abs_path,
                    'url': file_path,
                    'type': self._get_file_type(abs_path)
                })
        
        # If OCR text is available, append it to the user prompt so the LLM can
        # use it as authoritative content for transcription-heavy documents.
        if ocr_texts:
            try:
                parts = []
                for fd in file_data:
                    p = fd['path']
                    if p in ocr_texts and ocr_texts[p]:
                        fname = os.path.basename(p)
                        snippet = ocr_texts[p]
                        # Truncate extremely long OCR to keep token usage reasonable
                        if len(snippet) > 6000:
                            snippet = snippet[:6000] + "\n\u2026(truncated)"
                        parts.append(f"OCR text for {fname}:\n" + snippet)
                if parts:
                    if variant == 'finance':
                        guidance = (
                            "\n\nThe following is the OCR-extracted text from the document(s). "
                            "Use it as the authoritative source to fill ALL fields: "
                            "description, purchaseDate, price, tax (dollar amount), total, AND the items array. "
                            "Extract every line item you can find (name, qty/amount, unit price, line total). "
                            "Do NOT leave items as an empty array if the OCR text contains product/service lines."
                        )
                    else:
                        guidance = (
                            "\n\nWhen OCR text is provided, use it as ground truth for the actual wording. "
                            "Prefer verbatim transcription for 'description'."
                        )
                    user_prompt = user_prompt + guidance + "\n\n" + "\n\n".join(parts)
            except Exception:
                pass
        
        if not file_data:
            return self._get_default_entry_data(variant)
        
        # If provider cannot see images and we don't have OCR text, fail fast to avoid hallucinations.
        supports_vision = vision_capable(self.provider, self.model)
        has_ocr_text = bool(
            ocr_texts and any((ocr_texts.get(fd['path']) or '').strip() for fd in file_data)
        )
        if not supports_vision and not has_ocr_text:
            raise ValueError(
                "Selected AI provider does not support image inputs and no OCR text is available. "
                "Switch provider to a vision-capable model (DeepSeek Flash, OpenAI, Gemini or Claude) or install OCR (EasyOCR/pytesseract) in the server."
            )

        # Call LLM based on provider – let exceptions propagate so the caller marks the draft as error
        if self.provider == 'openai' and self.openai_client:
            return self._analyze_with_openai(system_prompt, user_prompt, file_data, variant)
        elif self.provider == 'deepseek' and self.deepseek_client:
            return self._analyze_with_openai(system_prompt, user_prompt, file_data, variant,
                                             client=self.deepseek_client)
        elif self.provider == 'gemini' and self.gemini_model:
            return self._analyze_with_gemini(system_prompt, user_prompt, file_data, variant)
        elif self.provider == 'anthropic' and self.anthropic_api_key:
            images = [fd['path'] for fd in file_data if fd['type'] == 'image']
            text = claude_llm.complete(self.anthropic_api_key, self.model, system_prompt,
                                       [{'role': 'user', 'content': user_prompt}], images=images)
            return self._parse_llm_response(text, variant)
        elif self.provider == 'custom' and self.custom_client:
            return self._analyze_with_openai(system_prompt, user_prompt, file_data, variant,
                                             client=self.custom_client)
        else:
            raise ValueError(
                f"LLM provider '{self.provider}' is not configured. "
                "Please add the API key in Settings → AI Analysis."
            )
    
    def _build_system_prompt(self, variant: str) -> str:
        """Build system prompt based on variant"""
        if variant == 'finance':
            return """You are an AI assistant that analyzes receipts, invoices, and financial documents.
Extract the following information from the image/file:
- description: Brief summary of the purchase or transaction
- category: Category like 'Groceries', 'Electronics', 'Dining', 'Transportation', 'Entertainment', etc.
- tags: Relevant keywords (array of strings)
- purchaseDate: Date in YYYY-MM-DD format
- price: Subtotal amount before tax (number, 0 if unknown)
- tax: Tax amount in dollars as written in the document (number, 0 if unknown)
- total: Final total amount (number, 0 if unknown)
- items: Array of individual line items extracted verbatim from the document (empty array [] if none found).
  Each item must have: {"name": "item name", "description": "extra detail or empty string", "amount": 1, "unitPrice": 0.00, "totalPrice": 0.00}

Return ONLY a valid JSON object with these exact keys. Defaults if a value cannot be determined:
- description: "Receipt/invoice"
- category: "Uncategorized"
- tags: []
- purchaseDate: Today's date
- price: 0
- tax: 0
- total: 0
- items: []

Example output:
{
  "description": "Grocery shopping at Whole Foods",
  "category": "Groceries",
  "tags": ["food", "organic"],
  "purchaseDate": "2025-01-15",
  "price": 45.50,
  "tax": 3.64,
  "total": 49.14,
  "items": [
    {"name": "Organic Apples", "description": "", "amount": 2, "unitPrice": 3.99, "totalPrice": 7.98},
    {"name": "Whole Milk", "description": "1 gallon", "amount": 1, "unitPrice": 4.49, "totalPrice": 4.49}
  ]
}"""
        else:
            return """You are an AI assistant that reads, transcribes, and analyses images and documents to create memo entries.

When the image contains text (e.g. a certificate, letter, receipt, screenshot, note, sign, or printed document):
  - READ and TRANSCRIBE the actual text content verbatim as the description.
  - Do NOT describe the image visually (e.g. do not say "a document showing a certificate").
  - Include all key names, titles, dates, and sentences found in the text.

When the image is purely visual with no meaningful text (e.g. a photo, diagram, or drawing):
  - Provide a clear factual description of what is depicted.

Extract the following fields:
- description: The full transcribed text or factual description of the content (be specific and complete)
- category: Appropriate category (e.g. 'Certificate', 'Award', 'Work', 'Personal', 'Reference', 'Project', etc.)
- tags: Relevant keywords derived from the actual content (array of strings)

Return ONLY a valid JSON object with these exact keys:
{
  "description": "Transcribed text or factual description",
  "category": "Category name",
  "tags": ["tag1", "tag2"]
}

If you cannot determine values, use:
- description: Brief factual description of what you see
- category: "Uncategorized"
- tags: []"""
    
    # Providers that support vision (image_url content parts)
    _VISION_PROVIDERS = {'openai', 'gemini', 'anthropic'}

    def _analyze_with_openai(
        self,
        system_prompt: str,
        user_prompt: str,
        file_data: List[Dict],
        variant: str,
        client=None,
    ) -> Dict[str, Any]:
        """Analyze files using OpenAI-compatible API (OpenAI, DeepSeek, etc.)"""
        client = client or self.openai_client
        supports_vision = vision_capable(self.provider, self.model)

        # Build user content
        content = [{"type": "text", "text": user_prompt}]

        image_descriptions = []
        for file_info in file_data:
            if file_info['type'] == 'image':
                if supports_vision:
                    with open(file_info['path'], 'rb') as f:
                        image_data = base64.b64encode(f.read()).decode('utf-8')
                    ext = file_info['path'].lower().split('.')[-1]
                    mime_map = {'jpg': 'jpeg', 'jpeg': 'jpeg', 'png': 'png', 'gif': 'gif', 'webp': 'webp'}
                    mime_type = f"image/{mime_map.get(ext, 'jpeg')}"
                    content.append({
                        "type": "image_url",
                        "image_url": {"url": f"data:{mime_type};base64,{image_data}"}
                    })
                else:
                    # Text-only provider: describe the file so the LLM knows what was attached
                    fname = os.path.basename(file_info['path'])
                    image_descriptions.append(f"[Attached image: {fname}]")

        # For text-only providers, append file names into the text prompt
        if image_descriptions:
            content[0]["text"] = user_prompt + "\n\n" + "\n".join(image_descriptions) + \
                "\n\nPlease analyse the attached file(s) and return the JSON as instructed."

        # DeepSeek and similar text-only APIs require content as a plain string, not an array
        if not supports_vision:
            user_content = content[0]["text"]
        else:
            user_content = content

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ]

        response = client.chat.completions.create(
            model=self.model,
            messages=messages,
            **openai_sampling(self.model, 0.3, 2000),
        )

        result_text = response.choices[0].message.content
        return self._parse_llm_response(result_text, variant)
    
    def _analyze_with_gemini(
        self,
        system_prompt: str,
        user_prompt: str,
        file_data: List[Dict],
        variant: str
    ) -> Dict[str, Any]:
        """Analyze files using Google Gemini Vision"""
        from PIL import Image
        
        # Prepare prompt parts
        prompt_parts = [system_prompt, user_prompt]
        
        # Add images
        for file_info in file_data:
            if file_info['type'] == 'image':
                img = Image.open(file_info['path'])
                prompt_parts.append(img)
        
        response = self.gemini_model.generate_content(prompt_parts)
        result_text = response.text
        
        return self._parse_llm_response(result_text, variant)
    
    def _parse_llm_response(self, response_text: str, variant: str) -> Dict[str, Any]:
        """Parse LLM response and extract JSON"""
        try:
            # Try to find JSON in the response
            # Sometimes LLM wraps it in markdown code blocks
            text = response_text.strip()
            
            # Remove markdown code blocks if present
            if text.startswith('```'):
                lines = text.split('\n')
                text = '\n'.join(lines[1:-1]) if len(lines) > 2 else text
                if text.startswith('json'):
                    text = text[4:].strip()
            
            # Parse JSON
            data = json.loads(text)
            
            # Validate and ensure required fields
            result = {
                'description': data.get('description', 'Analyzed content'),
                'category': data.get('category', 'Uncategorized'),
                'tags': data.get('tags', [])
            }
            
            if variant == 'finance':
                result['purchaseDate'] = data.get('purchaseDate', '')
                result['price'] = float(data.get('price', 0))
                try:
                    result['tax'] = float(data.get('tax', 0))
                except (ValueError, TypeError):
                    result['tax'] = 0
                result['total'] = float(data.get('total', 0))
                result['adjustment'] = float(data.get('adjustment', 0))
                # items: list of line-item dicts
                raw_items = data.get('items', [])
                if isinstance(raw_items, list):
                    cleaned = []
                    for it in raw_items:
                        if not isinstance(it, dict):
                            continue
                        try:
                            cleaned.append({
                                'name': str(it.get('name', '')),
                                'description': str(it.get('description', '')),
                                'amount': int(it.get('amount', 1)),
                                'unitPrice': float(it.get('unitPrice', 0)),
                                'totalPrice': float(it.get('totalPrice', 0)),
                            })
                        except (ValueError, TypeError):
                            pass
                    result['items'] = cleaned
                else:
                    result['items'] = []
            
            return result
            
        except (json.JSONDecodeError, ValueError) as e:
            print(f"⚠️ Failed to parse LLM response as JSON: {e}")
            print(f"Response was: {response_text[:200]}")
            return self._get_default_entry_data(variant)
    
    def _get_file_type(self, file_path: str) -> str:
        """Determine if file is an image or other type"""
        ext = file_path.lower().split('.')[-1]
        if ext in ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']:
            return 'image'
        return 'document'
    
    def _get_default_entry_data(self, variant: str) -> Dict[str, Any]:
        """Return default entry data when LLM is unavailable"""
        result = {
            'description': 'File uploaded - LLM analysis pending',
            'category': 'Uncategorized',
            'tags': ['needs-review']
        }
        
        if variant == 'finance':
            result.update({
                'purchaseDate': '',
                'price': 0,
                'tax': 0,
                'total': 0,
                'adjustment': 0,
                'items': []
            })
        
        return result


# Convenience function for easy import
def create_llm_service(
    provider: str = None,
    openai_key: str = None,
    gemini_key: str = None,
    deepseek_key: str = None,
    model: str = None,
    anthropic_key: str = None,
    custom_key: str = None,
    custom_base_url: str = None,
) -> LLMService:
    """
    Create and configure LLM service instance.

    Args:
        provider: 'openai', 'gemini', 'deepseek', 'anthropic' (Claude) or 'custom'
            (any OpenAI-compatible service) — defaults to env LLM_PROVIDER or 'gemini'
        openai_key: OpenAI API key (defaults to env OPENAI_API_KEY)
        gemini_key: Gemini API key (defaults to env GEMINI_API_KEY)
        deepseek_key: DeepSeek API key (defaults to env DEEPSEEK_API_KEY)
        model: Specific model (defaults to provider's default)
    """
    provider = provider or os.environ.get('LLM_PROVIDER', 'gemini')

    return LLMService(
        provider=provider,
        openai_api_key=openai_key,
        gemini_api_key=gemini_key,
        deepseek_api_key=deepseek_key,
        model=model,
        anthropic_api_key=anthropic_key,
        custom_api_key=custom_key,
        custom_base_url=custom_base_url,
    )
