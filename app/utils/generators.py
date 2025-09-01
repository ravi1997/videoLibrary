import random
import string

def generate_strong_password(length=16, use_symbols=True):
    if length < 8:
        raise ValueError("Password length should be at least 8 characters.")

    # Character sets
    lower = string.ascii_lowercase
    upper = string.ascii_uppercase
    digits = string.digits
    symbols = string.punctuation if use_symbols else ""

    # Make sure we include at least one of each selected type
    required = [
        random.choice(lower),
        random.choice(upper),
        random.choice(digits),
    ]
    if use_symbols:
        required.append(random.choice(symbols))

    # Fill the rest of the password length
    all_chars = lower + upper + digits + symbols
    remaining = [random.choice(all_chars) for _ in range(length - len(required))]

    # Shuffle and return
    password = required + remaining
    random.shuffle(password)
    return ''.join(password)


def generate_otp(length=6):
    if length < 4 or length > 10:
        raise ValueError("OTP length should be between 4 and 10 digits.")
    return ''.join(str(random.randint(0, 9)) for _ in range(length))

def generate_text_captcha(length=6):
    chars = string.ascii_uppercase + string.digits
    return ''.join(random.choices(chars, k=length))