import { IsInt, IsString, Min } from 'class-validator';

export class SubmitAnswerDto {
  @IsString()
  questionId: string;

  @IsInt()
  @Min(0)
  chosenIndex: number;
}
