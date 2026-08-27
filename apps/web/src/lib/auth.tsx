import { createContext, useContext, useEffect, useState } from "react";

import {
  clearToken,
  getSession,
  getToken,
  signIn as requestSignIn,
  signOut as requestSignOut,
} from "@/lib/api";
import type { Role, SessionUser } from "@/lib/api";

interface AuthContextValue {
  user: SessionUser | null;
  loading: boolean;
  error: string | null;
  signIn: (email: string, password: string) => Promise<SessionUser>;
  signOut: () => Promise<void>;
}
const AuthContext = createContext<AuthContextValue | null>(null);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sessionToken = getToken();
    let active = true;
    const loadSession = async () => {
      try {
        const session = await getSession();
        if (active && getToken() === sessionToken) {
          setUser(session.user);
        }
      } catch {
        if (active && getToken() === sessionToken) {
          clearToken();
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    void loadSession();
    return () => {
      active = false;
    };
  }, []);

  const signIn = async (email: string, password: string) => {
    setError(null);
    const response = await requestSignIn(email, password);
    let nextUser = response.user;
    if (!nextUser) {
      const session = await getSession();
      nextUser = session.user;
    }
    setUser(nextUser);
    return nextUser;
  };

  const signOut = async () => {
    await requestSignOut();
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ error, loading, signIn, signOut, user }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return context;
};

export const roleFor = (user: SessionUser | null): Role =>
  user?.role === "admin" ? "admin" : "user";
