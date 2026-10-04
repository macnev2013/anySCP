import { Toaster, useToastStore } from "anyscp";

// Seeded directly (not via toast.*) so the 6s auto-dismiss timer never fires.
useToastStore.setState({
  toasts: [
    { id: "t1", kind: "success", message: "Uploaded nginx.conf to /etc/nginx/sites-available" },
    { id: "t2", kind: "info", message: "Port forward 5432 → db-replica:5432 is active" },
    { id: "t3", kind: "error", message: "Couldn't launch “Visual Studio Code”: executable not found at /usr/local/bin/code" },
  ],
});

// Toaster is `fixed bottom-4 right-4`; the transformed stage contains it.
export const Stack = () => (
  <div className="bg-bg-base font-sans" style={{ width: 560, height: 300, transform: "translateZ(0)", overflow: "hidden", borderRadius: 8 }}>
    <Toaster />
  </div>
);
