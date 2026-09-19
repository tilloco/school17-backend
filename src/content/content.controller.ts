import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ContentService } from './content.service';
import { AdminApiKeyGuard } from '../admin-auth/admin-api-key.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateModuleDto, CreateWeekDto, CreateLessonDto, CreateQuestionDto, BulkCreateQuestionsDto } from './dto/content.dto';

@Controller('content')
export class ContentController {
  constructor(private contentService: ContentService) {}

  // --- Tizimga kirgan har qanday foydalanuvchi (Free yoki Premium) ---
  //
  // XAVFSIZLIK: avval bu ikkita route hech qanday guard'siz, TO'LIQ OCHIQ edi - bu
  // degani hisobsiz (login qilmagan) har kim /content/lessons/:id ni ketma-ket chaqirib,
  // BARCHA dars matnlari va test savollarini bepul yuklab olishi mumkin edi (Premium
  // to'siq faqat QuizService.submitAnswer - ya'ni javob berishda ishlaydi, o'qishda
  // emas). Bu butun Free/Premium biznes-modelini chetlab o'tar edi. Endi kamida
  // ro'yxatdan o'tgan (SMS OTP bilan tasdiqlangan) foydalanuvchi bo'lish shart -
  // ommaviy anonim scraping'ning oldi olinadi, Premium chegarasi esa hamon
  // QuizService'da (javob berishda) qo'llanadi.
  @UseGuards(JwtAuthGuard)
  @Get('modules')
  listModules() {
    return this.contentService.listModules();
  }

  @UseGuards(JwtAuthGuard)
  @Get('lessons/:id')
  getLesson(@Param('id') id: string) {
    return this.contentService.getLesson(id);
  }

  // --- Faqat admin (header: x-admin-key) ---

  @UseGuards(AdminApiKeyGuard)
  @Post('modules')
  createModule(@Body() dto: CreateModuleDto) {
    return this.contentService.createModule(dto);
  }

  @UseGuards(AdminApiKeyGuard)
  @Post('weeks')
  createWeek(@Body() dto: CreateWeekDto) {
    return this.contentService.createWeek(dto);
  }

  @UseGuards(AdminApiKeyGuard)
  @Post('lessons')
  createLesson(@Body() dto: CreateLessonDto) {
    return this.contentService.createLesson(dto);
  }
  @UseGuards(AdminApiKeyGuard)
  @Post('questions')
  createQuestion(@Body() dto: CreateQuestionDto) {
    return this.contentService.createQuestion(dto);
  }

  // Bitta lessonId + katta matn bo'lagi (bir nechta savol) - tezkor ommaviy qo'shish uchun
  @UseGuards(AdminApiKeyGuard)
  @Post('questions/bulk')
  createQuestionsBulk(@Body() dto: BulkCreateQuestionsDto) {
    return this.contentService.createQuestionsBulk(dto);
  }
  // Admin panelida modul → hafta → dars daraxtini ko'rish uchun (savol qo'shishda dars tanlash)
  @UseGuards(AdminApiKeyGuard)
  @Get('admin/modules')
  listModulesAdmin() {
    return this.contentService.listModules();
  }
  @UseGuards(AdminApiKeyGuard)
  @Delete('lessons/:id')
  deleteLesson(@Param('id') id: string) {
    return this.contentService.deleteLesson(id);
  }

  @UseGuards(AdminApiKeyGuard)
  @Delete('questions/:id')
  deleteQuestion(@Param('id') id: string) {
    return this.contentService.deleteQuestion(id);
  }
}