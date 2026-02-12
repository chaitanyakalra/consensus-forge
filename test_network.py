"""Test script to diagnose network and API issues."""
import httpx
import os
from dotenv import load_dotenv

load_dotenv()

def test_basic_connectivity():
    """Test basic HTTPS connectivity to OpenRouter."""
    print("=" * 60)
    print("TEST 1: Basic Connectivity")
    print("=" * 60)
    try:
        response = httpx.get("https://openrouter.ai/api/v1/models", timeout=10.0)
        print(f"✓ Status Code: {response.status_code}")
        print(f"✓ Can reach OpenRouter.ai")
        return True
    except Exception as e:
        print(f"✗ Failed to reach OpenRouter.ai: {e}")
        return False

def test_api_key():
    """Test if API key is loaded."""
    print("\n" + "=" * 60)
    print("TEST 2: API Key Configuration")
    print("=" * 60)
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        print("✗ OPENROUTER_API_KEY not found in environment!")
        print("  Please add it to .env file:")
        print("  OPENROUTER_API_KEY=sk-or-v1-...")
        return False
    else:
        print(f"✓ API Key found: {api_key[:15]}...{api_key[-4:]}")
        return True

def test_api_call():
    """Test actual API call with authentication."""
    print("\n" + "=" * 60)
    print("TEST 3: API Call with Authentication")
    print("=" * 60)
    
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not api_key:
        print("✗ Skipping - no API key")
        return False
    
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    
    payload = {
        "model": "openrouter/free",
        "messages": [{"role": "user", "content": "Say 'hello' in one word."}]
    }
    
    try:
        print("Sending test request...")
        response = httpx.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers=headers,
            json=payload,
            timeout=30.0
        )
        
        print(f"Status Code: {response.status_code}")
        
        if response.status_code == 200:
            data = response.json()
            print(f"✓ API call successful!")
            print(f"Response: {data['choices'][0]['message']['content']}")
            return True
        elif response.status_code == 401:
            print(f"✗ Authentication failed - Invalid API key")
            return False
        elif response.status_code == 502:
            print(f"✗ 502 Bad Gateway - This could be:")
            print("  1. Corporate network blocking/intercepting the request")
            print("  2. Corporate proxy/firewall issue")
            print("  3. SSL/TLS inspection breaking the connection")
            return False
        else:
            print(f"✗ Unexpected status: {response.status_code}")
            print(f"Response: {response.text}")
            return False
            
    except httpx.ProxyError as e:
        print(f"✗ Proxy Error: {e}")
        print("  Your network likely requires proxy configuration")
        return False
    except httpx.ConnectError as e:
        print(f"✗ Connection Error: {e}")
        print("  Network may be blocking the connection")
        return False
    except Exception as e:
        print(f"✗ Error: {type(e).__name__}: {e}")
        return False

def check_proxy_settings():
    """Check if proxy environment variables are set."""
    print("\n" + "=" * 60)
    print("TEST 4: Proxy Configuration")
    print("=" * 60)
    
    proxy_vars = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']
    found_proxy = False
    
    for var in proxy_vars:
        value = os.getenv(var)
        if value:
            print(f"✓ {var} = {value}")
            found_proxy = True
    
    if not found_proxy:
        print("ℹ No proxy environment variables set")
        print("  If your corporate network requires a proxy, you may need to set:")
        print("  HTTPS_PROXY=http://proxy.company.com:8080")

if __name__ == "__main__":
    print("\n🔍 OpenRouter Network Diagnostics\n")
    
    results = {
        "connectivity": test_basic_connectivity(),
        "api_key": test_api_key(),
    }
    
    check_proxy_settings()
    
    if results["api_key"]:
        results["api_call"] = test_api_call()
    
    print("\n" + "=" * 60)
    print("SUMMARY")
    print("=" * 60)
    for test, passed in results.items():
        status = "✓ PASS" if passed else "✗ FAIL"
        print(f"{test.upper()}: {status}")
    
    if not results.get("api_call", False):
        print("\n💡 RECOMMENDATIONS:")
        if not results["api_key"]:
            print("1. Add your OPENROUTER_API_KEY to the .env file")
        else:
            print("1. Contact your IT department about:")
            print("   - Firewall rules for openrouter.ai")
            print("   - SSL/TLS inspection settings")
            print("   - Required proxy configuration")
            print("2. Try running this from a personal network (home/mobile hotspot)")
            print("3. Check if VPN is required/causing issues")
