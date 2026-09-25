import subprocess
import time
import os

os.chdir(r"C:\Users\abc\Desktop\my chet\webrtc-voice-call")

print("Starting signaling server...")
sig_proc = subprocess.Popen(["node", r"signaling\server.js"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

print("Starting TURN server...")
turn_proc = subprocess.Popen(["node", "turn_server.js"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

time.sleep(2)

print("Running Playwright TURN tests...")
test_proc = subprocess.Popen(["node", "test_turn.js"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
test_out, test_err = test_proc.communicate()

sig_proc.terminate()
turn_proc.terminate()

print("=== TEST OUTPUT ===")
print(test_out)
if test_err:
    print("=== TEST ERROR ===")
    print(test_err)
