import {
  BadRequestException, Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req,
  UploadedFile, UseInterceptors, UsePipes,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import { z } from 'zod';
import { LOCALES, type LocaleCode } from '@daftar/shared-contracts';
import { AppError } from '@daftar/domain-core';
import { ZodValidationPipe } from '../../common/validation';
import { Membership, RequiresPermission } from '../../common/guards';
import type { MembershipContext } from '../tenancy/tenancy.service';
import { CatalogService } from './catalog.service';
import { MediaService } from './media.service';
import { CategoryCreateSchema, ProductCreateSchema, ProductUpdateSchema } from './catalog.schemas';

function localeOf(req: Request): LocaleCode {
  const raw = (req.headers['accept-language'] ?? 'ar').split(',')[0]?.trim() ?? 'ar';
  const base = raw.split('-')[0]?.toLowerCase() ?? 'ar';
  return (LOCALES as readonly string[]).includes(base) ? (base as LocaleCode) : 'ar';
}

function uuidParam(id: string): string {
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) {
    throw new BadRequestException('Invalid id');
  }
  return id;
}

@Controller('/v1/catalog')
export class CatalogController {
  constructor(
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(MediaService) private readonly media: MediaService,
  ) {}

  @Get('categories')
  @RequiresPermission('catalog.view')
  async listCategories(@Membership() m: MembershipContext) {
    return { items: await this.catalog.listCategories(m) };
  }

  @Post('categories')
  @RequiresPermission('category.manage')
  @UsePipes(new ZodValidationPipe(CategoryCreateSchema))
  async createCategory(@Membership() m: MembershipContext, @Body() body: unknown) {
    return this.catalog.createCategory(m, body as z.infer<typeof CategoryCreateSchema>);
  }

  @Get('products')
  @RequiresPermission('catalog.view')
  async listProducts(@Membership() m: MembershipContext, @Query() query: Record<string, unknown>, @Req() req: Request) {
    return this.catalog.listProducts(m, query, localeOf(req));
  }

  @Post('products')
  @RequiresPermission('catalog.create')
  @UsePipes(new ZodValidationPipe(ProductCreateSchema))
  async createProduct(@Membership() m: MembershipContext, @Body() body: unknown) {
    return this.catalog.createProduct(m, body as z.infer<typeof ProductCreateSchema>);
  }

  @Get('products/:id')
  @RequiresPermission('catalog.view')
  async getProduct(@Membership() m: MembershipContext, @Param('id') id: string, @Req() req: Request) {
    return this.catalog.getProduct(m, uuidParam(id), localeOf(req));
  }

  @Patch('products/:id')
  @RequiresPermission('catalog.update')
  @UsePipes(new ZodValidationPipe(ProductUpdateSchema))
  async updateProduct(@Membership() m: MembershipContext, @Param('id') id: string, @Body() body: unknown) {
    await this.catalog.updateProduct(m, uuidParam(id), body as z.infer<typeof ProductUpdateSchema>);
    return { ok: true };
  }

  @Delete('products/:id')
  @RequiresPermission('catalog.archive')
  async archiveProduct(@Membership() m: MembershipContext, @Param('id') id: string) {
    await this.catalog.archiveProduct(m, uuidParam(id));
    return { ok: true };
  }

  @Post('media')
  @RequiresPermission('media.manage')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }))
  async uploadMedia(@Membership() m: MembershipContext, @UploadedFile() file?: { buffer: Buffer; mimetype: string; originalname: string; size: number }) {
    if (!file) throw AppError.validation({ file: ['required'] });
    return this.media.upload(m, file);
  }

  @Post('products/:id/media/:mediaId')
  @RequiresPermission('media.manage')
  async attachMedia(@Membership() m: MembershipContext, @Param('id') id: string, @Param('mediaId') mediaId: string) {
    await this.media.attachToProduct(m, uuidParam(id), uuidParam(mediaId));
    return { ok: true };
  }

  /** §47: private-bucket access — authorized short-TTL signed URL. */
  @Get('media/:id/access-url')
  @RequiresPermission('catalog.view')
  async mediaAccessUrl(@Membership() m: MembershipContext, @Param('id') id: string) {
    return this.media.getAccessUrl(m, uuidParam(id));
  }
}
