"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { authClient } from "@tab402/auth/client";
import { Fingerprint, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";

const signInSchema = z.object({
  email: z.email(),
  password: z.string().min(1, "Enter your password"),
});
const signUpSchema = signInSchema.extend({
  name: z.string().min(1, "Enter your name"),
  password: z.string().min(10, "At least 10 characters"),
});

/** Mid-OAuth (an MCP client connecting), Better Auth answers sign-in with where to continue. */
function continueOAuth(data: unknown): boolean {
  const d = data as { redirect?: boolean; url?: string; redirect_uri?: string } | null | undefined;
  const to = d?.redirect_uri ?? (d?.redirect ? d.url : undefined);
  if (!to) return false;
  window.location.href = to;
  return true;
}

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const router = useRouter();
  const params = useSearchParams();
  const callbackURL = params.get("callbackURL") ?? "/";
  const [busy, setBusy] = useState(false);
  const schema = mode === "sign-up" ? signUpSchema : signInSchema;
  const form = useForm<z.input<typeof signUpSchema>>({
    resolver: zodResolver(schema as typeof signUpSchema),
    defaultValues: { email: "", password: "", name: "" },
  });

  async function onSubmit(values: z.input<typeof signUpSchema>) {
    setBusy(true);
    const res =
      mode === "sign-up"
        ? await authClient.signUp.email({
            email: values.email,
            password: values.password,
            name: values.name,
          })
        : await authClient.signIn.email({ email: values.email, password: values.password });
    setBusy(false);
    if (res.error) return toast.error(res.error.message ?? "Something went wrong");
    if (continueOAuth(res.data)) return;
    router.replace(callbackURL as never);
    router.refresh();
  }

  async function passkeySignIn() {
    setBusy(true);
    const res = await authClient.signIn.passkey();
    setBusy(false);
    if (res?.error) return toast.error(res.error.message ?? "Passkey sign-in failed");
    if (continueOAuth(res?.data)) return;
    router.replace(callbackURL as never);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {mode === "sign-up" ? "Create your account" : "Sign in"}
        </h1>
        <p className="text-sm text-muted-foreground">
          {mode === "sign-up"
            ? "Set a budget once; your agents pay per call within it."
            : "Welcome back."}
        </p>
      </div>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
          {mode === "sign-up" && (
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input autoComplete="name" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input type="email" autoComplete="email webauthn" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Password</FormLabel>
                <FormControl>
                  <Input
                    type="password"
                    autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <Button type="submit" disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            {mode === "sign-up" ? "Create account" : "Sign in"}
          </Button>
        </form>
      </Form>
      {mode === "sign-in" && (
        <>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <Separator className="flex-1" /> or <Separator className="flex-1" />
          </div>
          <Button variant="outline" onClick={passkeySignIn} disabled={busy}>
            <Fingerprint /> Sign in with a passkey
          </Button>
        </>
      )}
      <p className="text-sm text-muted-foreground">
        {mode === "sign-up" ? "Already have an account? " : "New to Tab402? "}
        <Link
          className="font-medium text-primary underline-offset-4 hover:underline"
          href={`/${mode === "sign-up" ? "sign-in" : "sign-up"}?callbackURL=${encodeURIComponent(callbackURL)}`}
        >
          {mode === "sign-up" ? "Sign in" : "Create an account"}
        </Link>
      </p>
    </div>
  );
}
