export interface SignUpDto {
  name: string;
  email: string;
  password: string;
  workspace: string;
}

export interface SignInDto {
  email: string;
  password: string;
}

export interface JwtPayload {
  sub: string;
  email: string;
  workspace: string;
}

export interface AuthUser {
  userId: string;
  email: string;
  workspace: string;
  name: string;
}
