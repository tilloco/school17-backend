import { IsString, IsInt, IsArray, ArrayMinSize, ArrayMaxSize, Min, IsOptional} from 'class-validator';

export class CreateModuleDto {
  @IsString()
  title: string;

  @IsInt()
  @Min(1)
  order: number;
}

export class CreateWeekDto {
  @IsString()
  moduleId: string;

  @IsString()
  title: string;

  @IsInt()
  @Min(1)
  order: number;
}

export class CreateLessonDto {
  @IsString()
  weekId: string;

  @IsString()
  title: string;

  @IsString()
  content: string;

  @IsInt()
  @Min(1)
  order: number;
}

export class CreateQuestionDto {
  @IsString()
  lessonId: string;

  @IsString()
  text: string;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(4)
  @IsString({ each: true })
  options: string[];

  @IsInt()
  @Min(0)
  correctIndex: number;

  @IsString()
  explanation: string;
}
export class BulkCreateQuestionsDto {
  @IsString()
  lessonId: string;

  @IsString()
  text: string;
    @IsOptional()
  @IsString()
  concept?: string;
}