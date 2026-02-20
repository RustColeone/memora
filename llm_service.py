"""
LLM Service for AI-powered entry generation
Supports OpenAI GPT-4 Vision and Google Gemini Vision
"""

import os
import json
import base64
from typing import Dict, List, Optional, Any

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


class LLMService:
    """Service for analyzing files/images and generating memo entries using LLM"""
    
    def __init__(
        self,
        provider: str = 'gemini',
        openai_api_key: Optional[str] = None,
        gemini_api_key: Optional[str] = None,
        model: Optional[str] = None
    ):
        """
        Initialize LLM Service
        
        Args:
            provider: 'openai' or 'gemini'
            openai_api_key: OpenAI API key (or from env)
            gemini_api_key: Google Gemini API key (or from env)
            model: Specific model to use (optional, uses defaults)
        """
        self.provider = provider.lower()
        self.openai_api_key = openai_api_key or os.environ.get('OPENAI_API_KEY')
        self.gemini_api_key = gemini_api_key or os.environ.get('GEMINI_API_KEY')
        
        # Set default models if not specified
        if model:
            self.model = model
        else:
            if self.provider == 'openai':
                self.model = 'gpt-4-vision-preview'
            elif self.provider == 'gemini':
                self.model = 'gemini-1.5-flash'  # or gemini-pro-vision
            else:
                self.model = None
        
        # Initialize clients
        self.openai_client = None
        self.gemini_model = None
        
        if self.provider == 'openai' and _openai_available and self.openai_api_key:
            self.openai_client = OpenAI(api_key=self.openai_api_key)
        
        if self.provider == 'gemini' and _gemini_available and self.gemini_api_key:
            genai.configure(api_key=self.gemini_api_key)
            self.gemini_model = genai.GenerativeModel(self.model)
    
    def analyze_files_for_entry(
        self,
        file_paths: List[str],
        user_message: str,
        variant: str = 'default',
        base_dir: str = '.'
    ) -> Dict[str, Any]:
        """
        Analyze uploaded files and generate entry metadata
        
        Args:
            file_paths: List of file paths relative to base_dir (e.g., ['/uploads/2025-01-01/image.jpg'])
            user_message: Optional user-provided context
            variant: 'default' or 'finance'
            base_dir: Base directory for file resolution
            
        Returns:
            Dictionary with entry metadata: description, category, tags, and finance fields if applicable
        """
        # Build system prompt based on variant
        system_prompt = self._build_system_prompt(variant)
        
        # Build user prompt
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
        
        if not file_data:
            return self._get_default_entry_data(variant)
        
        # Call LLM based on provider
        try:
            if self.provider == 'openai' and self.openai_client:
                return self._analyze_with_openai(system_prompt, user_prompt, file_data, variant)
            elif self.provider == 'gemini' and self.gemini_model:
                return self._analyze_with_gemini(system_prompt, user_prompt, file_data, variant)
            else:
                print(f"⚠️ LLM provider '{self.provider}' not available or not configured")
                return self._get_default_entry_data(variant)
        except Exception as e:
            print(f"❌ LLM analysis failed: {e}")
            return self._get_default_entry_data(variant)
    
    def _build_system_prompt(self, variant: str) -> str:
        """Build system prompt based on variant"""
        if variant == 'finance':
            return """You are an AI assistant that analyzes receipts and financial documents.
Extract the following information from the image/file:
- description: Brief summary of the purchase or transaction
- category: Category like 'Groceries', 'Electronics', 'Dining', 'Transportation', 'Entertainment', etc.
- tags: Relevant keywords (array of strings)
- purchaseDate: Date in YYYY-MM-DD format
- price: Subtotal amount before tax (number)
- tax: Tax amount (number)
- total: Final total amount (number)

Return ONLY a valid JSON object with these exact keys. If you cannot determine a value, use reasonable defaults:
- description: Brief description of what you see
- category: "Uncategorized"
- tags: []
- purchaseDate: Today's date
- price: 0
- tax: 0
- total: 0

Example output:
{
  "description": "Grocery shopping at Whole Foods",
  "category": "Groceries",
  "tags": ["food", "organic"],
  "purchaseDate": "2025-01-15",
  "price": 45.50,
  "tax": 3.64,
  "total": 49.14
}"""
        else:
            return """You are an AI assistant that analyzes images and documents to create memo entries.
Extract the following information:
- description: Clear description of what is shown in the image/file
- category: Appropriate category (e.g., 'Work', 'Personal', 'Reference', 'Project', etc.)
- tags: Relevant keywords (array of strings)

Return ONLY a valid JSON object with these exact keys:
{
  "description": "Description of the content",
  "category": "Category name",
  "tags": ["tag1", "tag2"]
}

If you cannot determine values, use:
- description: Brief description of what you see
- category: "Uncategorized"
- tags: []"""
    
    def _analyze_with_openai(
        self,
        system_prompt: str,
        user_prompt: str,
        file_data: List[Dict],
        variant: str
    ) -> Dict[str, Any]:
        """Analyze files using OpenAI GPT-4 Vision"""
        # Build messages with images
        content = [{"type": "text", "text": user_prompt}]
        
        for file_info in file_data:
            if file_info['type'] == 'image':
                # Read and encode image
                with open(file_info['path'], 'rb') as f:
                    image_data = base64.b64encode(f.read()).decode('utf-8')
                
                # Determine mime type
                ext = file_info['path'].lower().split('.')[-1]
                mime_map = {'jpg': 'jpeg', 'jpeg': 'jpeg', 'png': 'png', 'gif': 'gif', 'webp': 'webp'}
                mime_type = f"image/{mime_map.get(ext, 'jpeg')}"
                
                content.append({
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{mime_type};base64,{image_data}"
                    }
                })
        
        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": content}
        ]
        
        response = self.openai_client.chat.completions.create(
            model=self.model,
            messages=messages,
            max_tokens=500,
            temperature=0.3
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
                result['tax'] = float(data.get('tax', 0))
                result['total'] = float(data.get('total', 0))
                result['adjustment'] = float(data.get('adjustment', 0))
            
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
                'adjustment': 0
            })
        
        return result


# Convenience function for easy import
def create_llm_service(
    provider: str = None,
    openai_key: str = None,
    gemini_key: str = None,
    model: str = None
) -> LLMService:
    """
    Create and configure LLM service instance
    
    Args:
        provider: 'openai' or 'gemini' (defaults to env LLM_PROVIDER or 'gemini')
        openai_key: OpenAI API key (defaults to env OPENAI_API_KEY)
        gemini_key: Gemini API key (defaults to env GEMINI_API_KEY)
        model: Specific model (defaults to provider's default)
    """
    provider = provider or os.environ.get('LLM_PROVIDER', 'gemini')
    
    return LLMService(
        provider=provider,
        openai_api_key=openai_key,
        gemini_api_key=gemini_key,
        model=model
    )
