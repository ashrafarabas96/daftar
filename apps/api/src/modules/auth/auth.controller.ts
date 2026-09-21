import { Body, Controller, Get, Inject, Post, Req, UsePipes } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { LOCALES, type MeDto } from '@daftar/shared-contracts';
import { ZodValidationPipe } from '../../common/validation';
import { Principal, Public, type PrincipalInfo } from '../../common/guards';
import { clientIp } from '../../common/client-ip';
import type { AppConfig } from '../../config';
import { AuthService } from './auth.service';

const RegisterSchema = z
  .object({
    email: z.string().email().max(254),
    password: z.string().min(10).max(128),
    displayName: z.string().min(1).max(120),
    preferredLocale: z.enum(LOCALES as ['ar', 'en', 'tr']),
  })
  .strict();

const LoginSchema = z.object({ email: z.string().email(), password: z.string().min(1).max(128) }).strict();
const RefreshSchema = z.object({ refreshToken: z.string().min(20).max(512) }).strict();
const ResetRequestSchema = z.object({ email: z.string().email() }).strict();
const ResetSchema = z.object({ token: z.string().min(20).max(512), password: z.string().min(10).max(128) }).strict();

@Controller('/v1/auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject('APP_CONFIG') private readonly config: AppConfig,
  ) {}

  @Public()
  @Post('register')
  @UsePipes(new ZodValidationPipe(RegisterSchema))
  async register(@Body() body: unknown, @Req() req: Request) {
    return this.auth.register(body as z.infer<typeof RegisterSchema>, clientIp(req, this.config));
  }

  @Public()
  @Post('login')
  @UsePipes(new ZodValidationPipe(LoginSchema))
  async login(@Body() body: unknown, @Req() req: Request) {
    const b = body as z.infer<typeof LoginSchema>;
    return this.auth.login(b.email, b.password, clientIp(req, this.config));
  }

  @Public()
  @Post('refresh')
  @UsePipes(new ZodValidationPipe(RefreshSchema))
  async refresh(@Body() body: unknown, @Req() req: Request) {
    return this.auth.refresh((body as z.infer<typeof RefreshSchema>).refreshToken, clientIp(req, this.config));
  }

  @Public()
  @Post('password-reset/request')
  @UsePipes(new ZodValidationPipe(ResetRequestSchema))
  async requestReset(@Body() body: unknown, @Req() req: Request) {
    await this.auth.requestPasswordReset((body as z.infer<typeof ResetRequestSchema>).email, clientIp(req, this.config));
    // Identical response whether or not the email exists — no enumeration.
    return { ok: true };
  }

  @Public()
  @Post('password-reset/complete')
  @UsePipes(new ZodValidationPipe(ResetSchema))
  async completeReset(@Body() body: unknown, @Req() req: Request) {
    const b = body as z.infer<typeof ResetSchema>;
    await this.auth.resetPassword(b.token, b.password, clientIp(req, this.config));
    return { ok: true };
  }

  @Post('logout')
  async logout(@Principal() p: PrincipalInfo) {
    await this.auth.logout(p.sessionId);
    return { ok: true };
  }

  @Post('logout-all')
  async logoutAll(@Principal() p: PrincipalInfo) {
    await this.auth.logoutAll(p.userId);
    return { ok: true };
  }

  @Get('me')
  async me(@Principal() p: PrincipalInfo): Promise<MeDto> {
    return {
      userId: p.userId,
      email: p.email,
      displayName: p.displayName,
      preferredLocale: p.preferredLocale as MeDto['preferredLocale'],
    };
  }
}
