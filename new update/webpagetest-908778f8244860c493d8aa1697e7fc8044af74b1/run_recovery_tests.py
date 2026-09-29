import subprocess
import time
import os

os.chdir(r"C:\Users\abc\Desktop\my chet\webrtc-voice-call")

print("Skipping setup_webrtc_phase2.py...")

print("Starting signaling server...")
server_proc = subprocess.Popen(["node", r"signaling\server.js"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

time.sleep(2)

print("Running Playwright recovery tests...")
test_proc = subprocess.Popen(["node", "test_recovery.js"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
test_out, test_err = test_proc.communicate()

server_proc.terminate()
try:
    server_proc.wait(timeout=2)
except subprocess.TimeoutExpired:
    server_proc.kill()

server_out, server_err = server_proc.communicate()

print("=== TEST OUTPUT ===")
print(test_out)
if test_err:
    print("=== TEST ERROR ===")
    print(test_err)
