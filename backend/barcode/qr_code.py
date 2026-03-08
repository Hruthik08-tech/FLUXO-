import qrcode
from datetime import datetime
import sys
import os

# Accept input data from command-line arguments
if len(sys.argv) < 2:
    print("Usage: python qr_code.py <data>")
    sys.exit(1)

qr_data = sys.argv[1]

# Define the backend folder path
backend_folder = os.path.join(os.path.dirname(__file__), 'backend')
qr_folder = os.path.join(backend_folder, 'qr_codes')

# Ensure the qr_codes directory exists
os.makedirs(qr_folder, exist_ok=True)

# ----------- Generate QR Code -----------
qr = qrcode.QRCode(
    version=None,  # automatic size
    error_correction=qrcode.constants.ERROR_CORRECT_H,
    box_size=10,
    border=4,
)

qr.add_data(qr_data)
qr.make(fit=True)

img = qr.make_image(fill_color="black", back_color="white")

# Save QR Code in the backend/qr_codes folder
filename = os.path.join(qr_folder, f"product_qr_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png")
img.save(filename)

print("QR Code generated successfully!")
print("Saved as:", filename)
